"""Sparse Markov residual acceleration noise (Vague 1 — Gemini JSON TPM)."""

from __future__ import annotations

import json
import logging
import random
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.models.schemas import DriverProfile

logger = logging.getLogger(__name__)

MARKOV_DIR = Path(__file__).resolve().parents[1] / "data" / "markov"

_PROFILE_FILES: dict[str, str] = {
    "eco": "eco.json",
    "normal": "normal.json",
    "agressif": "agressif.json",
    "aggressive": "agressif.json",
    "sportif": "sportif.json",
    "sport": "sportif.json",
}


def _profile_key(profile: DriverProfile | str) -> str:
    if isinstance(profile, DriverProfile):
        return profile.value.lower()
    key = str(profile).strip().lower()
    if key in _PROFILE_FILES:
        if key == "aggressive":
            return "agressif"
        if key == "sport":
            return "sportif"
        return key
    try:
        return DriverProfile(str(profile).strip()).value.lower()
    except ValueError:
        return "normal"


@lru_cache(maxsize=8)
def load_tpm(profile: DriverProfile | str) -> dict[str, Any]:
    """Load sparse TPM JSON ``{"metadata":..., "tpm": {...}}`` (cached)."""
    key = _profile_key(profile)
    filename = _PROFILE_FILES.get(key, "normal.json")
    path = MARKOV_DIR / filename
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        logger.warning("Markov profile %s not found at %s — null noise", key, path)
        return {"metadata": {"profile": key}, "tpm": {}}
    if "tpm" not in data or not isinstance(data["tpm"], dict):
        logger.warning("Invalid TPM file %s — null noise", path)
        return {"metadata": data.get("metadata", {}), "tpm": {}}
    return data


class MarkovNoiseGenerator:
    """
    Sparse conditional distribution over a_noise given discretized (v, a).

    Keys: ``\"v_bin,a_bin\"`` where v_bin = floor(v / 10 m/s), a_bin ∈ {-1,0,1}.
    Missing states → a_noise = 0 (no crash).
    Critical braking / a_IDM ≤ -1 → forced zero (asymmetric safety).
    """

    def __init__(self, profile: DriverProfile | str = "normal") -> None:
        self.profile_key = _profile_key(profile)
        self._data = load_tpm(self.profile_key)
        self.tpm: dict[str, dict[str, float]] = {
            str(k): {str(nk): float(nv) for nk, nv in (v or {}).items()}
            for k, v in (self._data.get("tpm") or {}).items()
        }
        self.v_bin_size = 10.0  # m/s
        self.a_bin_thresh = 0.5  # m/s² → bins -1 / 0 / 1

    def _discretize_state(self, v: float, a: float) -> str:
        v_bin = int(max(0.0, float(v)) // self.v_bin_size)
        if a < -self.a_bin_thresh:
            a_bin = -1
        elif a > self.a_bin_thresh:
            a_bin = 1
        else:
            a_bin = 0
        return f"{v_bin},{a_bin}"

    def sample_noise(
        self,
        current_v: float,
        current_a_idm: float,
        *,
        is_critical_braking: bool = False,
        rng: random.Random | None = None,
    ) -> float:
        """Sample a_noise (m/s²) with asymmetric safety gate."""
        if is_critical_braking or current_a_idm <= -1.0:
            return 0.0

        state_key = self._discretize_state(current_v, current_a_idm)
        distribution = self.tpm.get(state_key)
        if not distribution:
            return 0.0

        noises = [float(k) for k in distribution.keys()]
        weights = [max(0.0, float(w)) for w in distribution.values()]
        total = sum(weights)
        if total <= 0 or not noises:
            return 0.0

        # Prefer seeded RNG for reproducibility; fall back to module random
        if rng is not None:
            pick = rng.random() * total
            acc = 0.0
            chosen = noises[-1]
            for n, w in zip(noises, weights):
                acc += w
                if pick <= acc:
                    chosen = n
                    break
            return float(chosen)

        return float(random.choices(noises, weights=weights, k=1)[0])


# Backward-compatible alias used by kinematic_solver / tests
MarkovNoise = MarkovNoiseGenerator


def sample_noise(
    driver_profile: DriverProfile | str,
    v_mps: float,
    a_idm: float,
    rng: random.Random | None = None,
    *,
    is_critical_braking: bool = False,
) -> float:
    """Convenience wrapper."""
    return MarkovNoiseGenerator(driver_profile).sample_noise(
        v_mps,
        a_idm,
        is_critical_braking=is_critical_braking,
        rng=rng,
    )
