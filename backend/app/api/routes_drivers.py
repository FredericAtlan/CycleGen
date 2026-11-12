"""Driver fingerprint / aggregate API — thin router over rs_fingerprint."""

from __future__ import annotations

import json
import logging
import math
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field, field_validator

from app.models.schemas import _MAX_PROFILE_POINTS
from app.services.rs_fingerprint import (
    DriverFingerprint,
    aggregate_fingerprints,
    fingerprint_payload,
    preview_table_bytes,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/drivers", tags=["drivers"])

_FINGERPRINT_KEYS = frozenset(DriverFingerprint.__dataclass_fields__)
_MAX_FINGERPRINT_FIELDS = len(_FINGERPRINT_KEYS)
_MAX_FINGERPRINT_BYTES = 8192
_MAX_UPLOAD_BYTES = 40_000_000
_UPLOAD_CHUNK_BYTES = 1_048_576

_MSG_SERIES_TOO_LARGE = "series exceeds maximum point count"
_MSG_FILE_TOO_LARGE = "file too large (>40 MB)"
_MSG_INVALID_INPUT = "invalid fingerprint input"
_MSG_PROCESSING_FAILED = "fingerprint processing failed"
_MSG_INVALID_AGGREGATE = "invalid aggregate fingerprint"


class SeriesFingerprintBody(BaseModel):
    t: list[float] = Field(..., min_length=3, max_length=_MAX_PROFILE_POINTS)
    v: list[float] = Field(
        ..., min_length=3, max_length=_MAX_PROFILE_POINTS, description="Velocity m/s"
    )
    lim: list[float] | None = Field(
        default=None,
        max_length=_MAX_PROFILE_POINTS,
        description="Posted speed limit km/h (optional)",
    )
    filename: str | None = None
    use_p85: bool = True


def _validate_fingerprint_dict(v: dict[str, Any]) -> dict[str, Any]:
    if len(v) > _MAX_FINGERPRINT_FIELDS:
        raise ValueError("fingerprint has too many fields")
    try:
        encoded = json.dumps(v, separators=(",", ":"), sort_keys=True).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError("fingerprint is not serializable") from exc
    if len(encoded) > _MAX_FINGERPRINT_BYTES:
        raise ValueError("fingerprint payload too large")
    unknown = set(v.keys()) - _FINGERPRINT_KEYS
    if unknown:
        raise ValueError("fingerprint contains unknown fields")
    for key, val in v.items():
        if isinstance(val, bool):
            raise ValueError("fingerprint values must be numeric")
        if not isinstance(val, (int, float)):
            raise ValueError("fingerprint values must be numeric")
        if not math.isfinite(float(val)):
            raise ValueError("fingerprint values must be finite numbers")
    return v


class AggregateItem(BaseModel):
    style: str = Field(..., description="prudent | dynamique | prea | …")
    fingerprint: dict[str, Any]

    @field_validator("fingerprint")
    @classmethod
    def _fingerprint_shape(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _validate_fingerprint_dict(v)


class AggregateBody(BaseModel):
    items: list[AggregateItem] = Field(..., min_length=1, max_length=32)


def _fingerprint_value_error(exc: ValueError) -> HTTPException:
    if "points; max" in str(exc):
        return HTTPException(413, _MSG_SERIES_TOO_LARGE)
    return HTTPException(400, _MSG_INVALID_INPUT)


def _parse_content_length(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        n = int(value)
    except ValueError:
        return None
    if n < 0:
        return None
    return n


async def _read_bounded_upload(
    file: UploadFile,
    *,
    content_length: int | None,
    max_bytes: int = _MAX_UPLOAD_BYTES,
) -> bytes:
    if content_length is not None and content_length > max_bytes:
        raise HTTPException(413, _MSG_FILE_TOO_LARGE)
    buf = bytearray()
    while True:
        chunk = await file.read(_UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > max_bytes:
            raise HTTPException(413, _MSG_FILE_TOO_LARGE)
    return bytes(buf)


@router.post("/preview")
async def preview_upload(
    request: Request,
    file: UploadFile | None = File(default=None),
) -> dict[str, Any]:
    """Preview headers + sample rows + suggested Temps / Vitesse columns."""
    if file is None:
        raise HTTPException(400, "multipart file required")
    content_length = _parse_content_length(request.headers.get("content-length"))
    raw = await _read_bounded_upload(file, content_length=content_length)
    if not raw:
        raise HTTPException(400, "empty file")
    try:
        return preview_table_bytes(raw, file.filename or "upload")
    except ValueError as exc:
        logger.info("preview rejected: %s", exc)
        raise HTTPException(400, _MSG_INVALID_INPUT) from exc
    except Exception as exc:  # noqa: BLE001
        logger.warning("preview failed", exc_info=exc)
        raise HTTPException(400, _MSG_PROCESSING_FAILED) from exc


@router.post("/fingerprint")
async def fingerprint_upload(
    request: Request,
    file: UploadFile | None = File(default=None),
    col_t: int | None = Form(default=None),
    col_v: int | None = Form(default=None),
    v_unit: str | None = Form(default=None),
) -> dict[str, Any]:
    """Upload CSV / .xls / .xlsx / JSON → fingerprint + suggested physics + sha256.

    Optional form fields: ``col_t``, ``col_v`` (0-based indices), ``v_unit`` (mps|kmh).
    """
    if file is None:
        raise HTTPException(400, "multipart file required (or use /fingerprint/series)")
    content_length = _parse_content_length(request.headers.get("content-length"))
    raw = await _read_bounded_upload(file, content_length=content_length)
    if not raw:
        raise HTTPException(400, "empty file")

    unit = v_unit.strip().lower() if v_unit else None
    if unit is not None and unit not in ("mps", "kmh"):
        raise HTTPException(400, _MSG_INVALID_INPUT)

    try:
        return fingerprint_payload(
            raw=raw,
            filename=file.filename or "upload",
            use_p85=True,
            col_t=col_t,
            col_v=col_v,
            v_unit=unit,
        )
    except ValueError as exc:
        logger.info("fingerprint upload rejected: %s", exc)
        raise _fingerprint_value_error(exc) from exc
    except Exception as exc:  # noqa: BLE001
        logger.warning("fingerprint upload failed", exc_info=exc)
        raise HTTPException(400, _MSG_PROCESSING_FAILED) from exc


@router.post("/fingerprint/series")
async def fingerprint_series_json(body: SeriesFingerprintBody) -> dict[str, Any]:
    """JSON series fingerprint (no file) — sha256 omitted."""
    if len(body.t) != len(body.v):
        raise HTTPException(400, "t and v length mismatch")
    if body.lim is not None and len(body.lim) != len(body.t):
        raise HTTPException(400, "lim length mismatch")
    try:
        return fingerprint_payload(
            series={"t": body.t, "v": body.v, **({"lim": body.lim} if body.lim else {})},
            filename=body.filename,
            use_p85=body.use_p85,
        )
    except ValueError as exc:
        logger.info("fingerprint series rejected: %s", exc)
        raise _fingerprint_value_error(exc) from exc


@router.post("/aggregate")
async def aggregate_drivers(body: AggregateBody) -> dict[str, Any]:
    """Multi-file fingerprints → Prudent / Dynamique / PreA packs."""
    try:
        return aggregate_fingerprints(
            [{"style": it.style, "fingerprint": it.fingerprint} for it in body.items]
        )
    except ValueError as exc:
        logger.info("aggregate rejected: %s", exc)
        raise HTTPException(400, _MSG_INVALID_AGGREGATE) from exc
