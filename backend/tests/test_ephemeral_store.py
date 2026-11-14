"""P0 security guards: ephemeral store + corridor caps helpers."""

from __future__ import annotations

import time
import unittest

from app.services.ephemeral_store import EphemeralStore


class TestEphemeralStore(unittest.TestCase):
    def test_ttl_purge(self) -> None:
        store: EphemeralStore[str] = EphemeralStore(
            max_items=10, ttl_s=0.05, name="t"
        )
        store.put("a", "x")
        self.assertEqual(store.get("a"), "x")
        time.sleep(0.06)
        self.assertIsNone(store.get("a"))

    def test_prefer_evict_blocks_when_all_hot(self) -> None:
        store: EphemeralStore[dict] = EphemeralStore(
            max_items=2,
            ttl_s=3600,
            name="t",
            prefer_evict=lambda v: v.get("status") != "running",
        )
        self.assertTrue(store.try_put("1", {"status": "running"}))
        self.assertTrue(store.try_put("2", {"status": "running"}))
        self.assertFalse(store.try_put("3", {"status": "running"}))
        # Completed can be evicted to free a slot.
        store.put("1", {"status": "completed"})
        self.assertTrue(store.try_put("3", {"status": "running"}))
        self.assertIsNone(store.get("1"))
        self.assertIsNotNone(store.get("3"))

    def test_overflow_evicts_oldest_when_forced(self) -> None:
        store: EphemeralStore[int] = EphemeralStore(
            max_items=2, ttl_s=3600, name="t"
        )
        store.put("a", 1)
        store.put("b", 2)
        store.put("c", 3)
        self.assertEqual(len(store), 2)
        self.assertIsNone(store.get("a"))
        self.assertEqual(store.get("c"), 3)


if __name__ == "__main__":
    unittest.main()
