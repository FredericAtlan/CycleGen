"""Export API — consolidated profile to CSV or XML."""

from __future__ import annotations

import csv
import io
import math
import xml.etree.ElementTree as ET

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.models.schemas import ExportRequest

router = APIRouter(tags=["export"])


def _slope_pct(alpha_rad: float) -> float:
    """Road grade in percent: 100 * tan(α)."""
    return math.tan(alpha_rad) * 100.0


def _profile_csv(body: ExportRequest) -> tuple[io.StringIO, str]:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["time", "position", "velocity", "acceleration", "slope_pct"]
    )
    p = body.profile
    n = min(
        len(p.time),
        len(p.position),
        len(p.velocity),
        len(p.acceleration),
        len(p.slope),
    )
    for i in range(n):
        writer.writerow(
            [
                f"{p.time[i]:.6f}",
                f"{p.position[i]:.6f}",
                f"{p.velocity[i]:.6f}",
                f"{p.acceleration[i]:.6f}",
                f"{_slope_pct(p.slope[i]):.6f}",
            ]
        )
    buf.seek(0)
    return buf, "cyclegen_profile.csv"


def _profile_xml(body: ExportRequest) -> tuple[io.StringIO, str]:
    p = body.profile
    root = ET.Element(
        "CycleGen",
        {
            "total_duration_s": f"{p.total_duration_s:.6f}",
            "average_speed_kmh": f"{p.average_speed_kmh:.6f}",
            "status": p.status,
            "slope_unit": "percent",
        },
    )
    samples = ET.SubElement(root, "samples")
    n = min(
        len(p.time),
        len(p.position),
        len(p.velocity),
        len(p.acceleration),
        len(p.slope),
    )
    for i in range(n):
        ET.SubElement(
            samples,
            "sample",
            {
                "time": f"{p.time[i]:.6f}",
                "position": f"{p.position[i]:.6f}",
                "velocity": f"{p.velocity[i]:.6f}",
                "acceleration": f"{p.acceleration[i]:.6f}",
                "slope_pct": f"{_slope_pct(p.slope[i]):.6f}",
            },
        )
    tree = ET.ElementTree(root)
    buf = io.StringIO()
    tree.write(buf, encoding="unicode", xml_declaration=True)
    buf.seek(0)
    return buf, "cyclegen_profile.xml"


@router.post("/export")
async def export_profile(body: ExportRequest) -> StreamingResponse:
    """Stream a consolidated driving-cycle profile as CSV or XML."""
    if body.format == "xml":
        buf, filename = _profile_xml(body)
        media = "application/xml"
    else:
        buf, filename = _profile_csv(body)
        media = "text/csv"

    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
