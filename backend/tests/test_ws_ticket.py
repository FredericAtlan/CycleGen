"""HMAC WebSocket ticket verification."""

from __future__ import annotations

import hashlib
import hmac
import time
import unittest

from app.services.ws_ticket import TICKET_MAX_SKEW_SEC, verify_ws_ticket


def _sign(api_key: str, ts: int | None = None) -> str:
    ts_str = str(int(ts if ts is not None else time.time()))
    sig = hmac.new(
        api_key.encode("utf-8"),
        ts_str.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{ts_str}.{sig}"


class TestWsTicket(unittest.TestCase):
    def test_valid_ticket(self) -> None:
        key = "test-secret-key"
        self.assertTrue(verify_ws_ticket(_sign(key), key))

    def test_wrong_key(self) -> None:
        self.assertFalse(verify_ws_ticket(_sign("a"), "b"))

    def test_expired_ticket(self) -> None:
        key = "test-secret-key"
        old = int(time.time()) - TICKET_MAX_SKEW_SEC - 5
        self.assertFalse(verify_ws_ticket(_sign(key, old), key))

    def test_future_within_skew(self) -> None:
        key = "test-secret-key"
        future = int(time.time()) + 30
        self.assertTrue(verify_ws_ticket(_sign(key, future), key))

    def test_malformed(self) -> None:
        self.assertFalse(verify_ws_ticket("", "key"))
        self.assertFalse(verify_ws_ticket("not-a-ticket", "key"))
        self.assertFalse(verify_ws_ticket("123.", "key"))
