"""Thin session helper around ``SumoBridge`` for Agent G.

Encapsulates prepare → start → iterate → stop without owning simulation policy
(seed, WS framing, IDM fallback). Prefer this when you want a single context
manager; use ``SumoBridge`` directly for live WebSocket step loops.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

from app.services.sumo_bridge import (
    DEFAULT_PORT,
    DEFAULT_WORK_DIR,
    SumoBridge,
    SumoNotAvailableError,
)


class SumoSession:
    """Context-managed SUMO run bound to one corridor + driver profile."""

    def __init__(
        self,
        corridor: Any,
        driver_profile: Any = "Normal",
        *,
        work_dir: str | Path | None = None,
        port: int | None = None,
        use_osm: bool = False,
        bridge: SumoBridge | None = None,
    ) -> None:
        self.corridor = corridor
        self.driver_profile = driver_profile
        self.work_dir = Path(work_dir or DEFAULT_WORK_DIR)
        self.port = DEFAULT_PORT if port is None else int(port)
        self.use_osm = use_osm
        self.bridge = bridge or SumoBridge()
        self._prepared = False

    def __enter__(self) -> SumoSession:
        if not SumoBridge.available():
            raise SumoNotAvailableError(
                "SUMO/TraCI not available — Agent G should fall back to IDM"
            )
        self.bridge.prepare(
            self.corridor,
            self.driver_profile,
            self.work_dir,
            port=self.port,
            use_osm=self.use_osm,
        )
        self.bridge.start_traci(self.port)
        self._prepared = True
        return self

    def __exit__(self, *exc: object) -> None:
        self.bridge.stop()

    def step(self) -> dict[str, Any]:
        self.bridge.step()
        return self.bridge.snapshot()

    def frames(self, max_steps: int = 3600) -> Iterator[dict[str, Any]]:
        """Yield snapshots until arrival / empty sim / max_steps (does not stop)."""
        for _ in range(max_steps):
            frame = self.step()
            yield frame
            if frame.get("ego_arrived"):
                break
