"""Redact secrets from exception / URL strings before returning to clients."""

from __future__ import annotations

import re

_TOKEN_PATTERNS = (
    re.compile(r"(access_token=)([^&\s\"']+)", re.IGNORECASE),
    re.compile(r"(authorization:\s*bearer\s+)(\S+)", re.IGNORECASE),
    re.compile(r"(api[_-]?key=)([^&\s\"']+)", re.IGNORECASE),
)


def redact_secrets(text: object) -> str:
    """Strip tokens / API keys from error messages and URLs."""
    s = str(text) if text is not None else ""
    for pat in _TOKEN_PATTERNS:
        s = pat.sub(r"\1***", s)
    return s
