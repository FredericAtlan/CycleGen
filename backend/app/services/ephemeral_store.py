"""Bounded in-memory stores with TTL + max size (DoS / OOM mitigation)."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Generic, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


class EphemeralStore(Generic[T]):
    """Thread-safe dict with monotonic TTL and overflow eviction."""

    def __init__(
        self,
        *,
        max_items: int,
        ttl_s: float,
        name: str = "store",
        prefer_evict: Callable[[T], bool] | None = None,
    ) -> None:
        self._max = max(1, int(max_items))
        self._ttl = max(0.01, float(ttl_s))
        self._name = name
        self._prefer_evict = prefer_evict
        self._lock = threading.Lock()
        self._items: dict[str, tuple[float, T]] = {}

    @property
    def max_items(self) -> int:
        return self._max

    @property
    def ttl_s(self) -> float:
        return self._ttl

    def put(self, key: str, value: T) -> None:
        with self._lock:
            self._purge_unlocked()
            self._items[key] = (time.monotonic(), value)
            self._evict_overflow_unlocked()

    def try_put(self, key: str, value: T) -> bool:
        """Put if a slot is free (or an evictable entry exists). Else False."""
        with self._lock:
            self._purge_unlocked()
            if key not in self._items and len(self._items) >= self._max:
                if not self._evict_one_unlocked(force=False):
                    return False
            self._items[key] = (time.monotonic(), value)
            self._evict_overflow_unlocked()
            return True

    def get(self, key: str) -> T | None:
        with self._lock:
            self._purge_unlocked()
            hit = self._items.get(key)
            return hit[1] if hit is not None else None

    def discard(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)

    def __len__(self) -> int:
        with self._lock:
            self._purge_unlocked()
            return len(self._items)

    def _purge_unlocked(self) -> None:
        now = time.monotonic()
        dead = [k for k, (ts, _) in self._items.items() if now - ts > self._ttl]
        for k in dead:
            del self._items[k]
        if dead:
            logger.info(
                "%s: purged %d expired entr(y/ies) (ttl=%.0fs)",
                self._name,
                len(dead),
                self._ttl,
            )

    def _evict_one_unlocked(self, *, force: bool) -> bool:
        if not self._items:
            return False
        if self._prefer_evict is not None:
            for k, (_, v) in self._items.items():
                if self._prefer_evict(v):
                    del self._items[k]
                    logger.warning(
                        "%s: evicted '%s…' (prefer_evict)",
                        self._name,
                        k[:8],
                    )
                    return True
            if not force:
                return False
        # Oldest insertion order.
        k = next(iter(self._items))
        del self._items[k]
        logger.warning("%s: evicted '%s…' (oldest)", self._name, k[:8])
        return True

    def _evict_overflow_unlocked(self) -> None:
        while len(self._items) > self._max:
            if not self._evict_one_unlocked(force=True):
                break
