"""Short-lived HMAC tickets for browser WebSocket upgrades (no public API key)."""

from __future__ import annotations

import hashlib
import hmac
import time

TICKET_MAX_SKEW_SEC = 120


def verify_ws_ticket(ticket: str, api_key: str) -> bool:
    """Return True when ``ticket`` is ``{unix_seconds}.{hex_hmac}`` signed with ``api_key``."""
    ticket = (ticket or "").strip()
    key = (api_key or "").strip()
    if not ticket or not key:
        return False
    parts = ticket.split(".", 1)
    if len(parts) != 2:
        return False
    ts_str, sig = parts[0].strip(), parts[1].strip()
    if not ts_str or not sig:
        return False
    try:
        ts = int(ts_str)
    except ValueError:
        return False
    now = int(time.time())
    if abs(now - ts) > TICKET_MAX_SKEW_SEC:
        return False
    expected = hmac.new(
        key.encode("utf-8"),
        ts_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, sig)
