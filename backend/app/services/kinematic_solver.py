"""IDM kinematic solver — SUMO-free fallback for CycleGen driving cycles."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Any, Sequence

from app.models.schemas import (
    ConsolidatedProfile,
    DriverProfile,
    FeuMeta,
    SimulationFrame,
    SpatialCorridor,
    VehicleSnapshot,
)
from app.services.markov_noise import MarkovNoiseGenerator

DT = 1.0  # s
DELTA = 4.0  # IDM free-road exponent
MAX_STEPS = 50_000
VEHICLE_LENGTH_M = 4.5
# Horizon scan step (m) inside D_horizon = v · T_h.
HORIZON_SCAN_STEP_M = 5.0
# Engage virtual leader only if required mean deceleration is below this (m/s²).
HORIZON_BRAKE_EPS = -0.08
ARTERIAL_HIGHWAYS = frozenset({"primary", "trunk"})
ARTERIAL_MIN_SPACING_M = 500.0

# P1 — Grade coupling. Injected as a_grade = −g·sin(α(s)) into IDM output.
# Kinematic driver only (no aero/roll modelled); AVL CRUISE plant is out of scope.
G_EARTH = 9.80665
# P2 — MPC-lite preview braking horizon (s). Used on top of T_h scan.
PREVIEW_T_LOOK_S = 5.0
PREVIEW_STEP_M = 5.0

DEFAULT_TLS_CYCLE_S = 90.0
DEFAULT_TLS_GREEN_S = 35.0


@dataclass(frozen=True)
class IDMParams:
    a_max: float
    b_comf: float
    speed_factor: float
    T: float
    s0: float
    # Scan horizon time (s): D_horizon = v · T_h.
    T_h: float = 4.0
    # Max |da/dt| when accelerating (m/s³). 0 disables.
    jerk_max: float = 1.0
    # Max |da/dt| when braking (m/s³). 0 → falls back to jerk_max.
    jerk_brake_max: float = 0.0


# Gemini macroscopic matrix (Eco / Normal / Sport). AVL/BCB via overrides.
PROFILE_PARAMS: dict[DriverProfile, IDMParams] = {
    DriverProfile.ECO: IDMParams(
        a_max=1.2,
        b_comf=1.2,
        speed_factor=0.95,
        T=2.0,
        s0=3.0,
        T_h=5.0,
        jerk_max=0.5,
        jerk_brake_max=1.5,
    ),
    DriverProfile.NORMAL: IDMParams(
        a_max=2.0,
        b_comf=2.0,
        speed_factor=1.05,
        T=1.5,
        s0=2.0,
        T_h=3.5,
        jerk_max=1.5,
        jerk_brake_max=3.0,
    ),
    DriverProfile.AGRESSIF: IDMParams(
        a_max=3.2,
        b_comf=3.2,
        speed_factor=1.12,
        T=1.1,
        s0=1.6,
        T_h=2.8,
        jerk_max=2.5,
        jerk_brake_max=4.0,
    ),
    DriverProfile.SPORTIF: IDMParams(
        a_max=3.5,
        b_comf=3.5,
        speed_factor=1.10,
        T=1.0,
        s0=1.5,
        T_h=2.5,
        jerk_max=3.0,
        jerk_brake_max=5.0,
    ),
}


def resolve_profile(
    driver_profile: DriverProfile | str,
    *,
    overrides: dict[str, float] | None = None,
) -> tuple[DriverProfile, IDMParams]:
    if isinstance(driver_profile, DriverProfile):
        profile = driver_profile
    else:
        key = str(driver_profile).strip()
        try:
            profile = DriverProfile(key)
        except ValueError:
            lowered = key.lower()
            mapping = {
                "eco": DriverProfile.ECO,
                "normal": DriverProfile.NORMAL,
                "agressif": DriverProfile.AGRESSIF,
                "aggressive": DriverProfile.AGRESSIF,
                "sportif": DriverProfile.SPORTIF,
                "sport": DriverProfile.SPORTIF,
            }
            profile = mapping.get(lowered, DriverProfile.NORMAL)
    base = PROFILE_PARAMS[profile]
    if not overrides:
        return profile, base
    return profile, IDMParams(
        a_max=float(overrides.get("a_max", base.a_max)),
        b_comf=float(overrides.get("b_comf", base.b_comf)),
        speed_factor=float(overrides.get("speed_factor", base.speed_factor)),
        T=float(overrides.get("T", base.T)),
        s0=float(overrides.get("s0", base.s0)),
        T_h=float(overrides.get("T_h", base.T_h)),
        jerk_max=float(overrides.get("jerk_max", base.jerk_max)),
        jerk_brake_max=float(
            overrides.get("jerk_brake_max", base.jerk_brake_max)
        ),
    )


def _params_for_s(
    base: IDMParams,
    zones: list[dict[str, Any]] | None,
    s_m: float,
) -> IDMParams:
    """Pick IDM params from the zone containing ``s_m`` (distance split)."""
    if not zones:
        return base
    ordered = sorted(zones, key=lambda z: float(z.get("s0_m") or 0.0))
    hit: dict[str, Any] | None = None
    for z in ordered:
        s0 = float(z.get("s0_m") or 0.0)
        s1 = z.get("s1_m")
        if s_m + 1e-6 < s0:
            continue
        if s1 is not None and float(s1) <= s_m:
            continue
        hit = z
    if hit is None:
        hit = ordered[0] if ordered else None
    if not hit:
        return base
    return IDMParams(
        a_max=float(hit["a_max"]) if hit.get("a_max") is not None else base.a_max,
        b_comf=float(hit["b_comf"]) if hit.get("b_comf") is not None else base.b_comf,
        speed_factor=(
            float(hit["speed_factor"])
            if hit.get("speed_factor") is not None
            else base.speed_factor
        ),
        T=float(hit["T"]) if hit.get("T") is not None else base.T,
        s0=float(hit["s0"]) if hit.get("s0") is not None else base.s0,
        T_h=float(hit["T_h"]) if hit.get("T_h") is not None else base.T_h,
        jerk_max=(
            float(hit["jerk_max"])
            if hit.get("jerk_max") is not None
            else base.jerk_max
        ),
        jerk_brake_max=(
            float(hit["jerk_brake_max"])
            if hit.get("jerk_brake_max") is not None
            else base.jerk_brake_max
        ),
    )


def _interp(s_query: float, S: Sequence[float], values: Sequence[float]) -> float:
    if not S or not values:
        return 0.0
    n = min(len(S), len(values))
    S = list(S[:n])
    values = list(values[:n])
    if s_query <= S[0]:
        return float(values[0])
    if s_query >= S[-1]:
        return float(values[-1])
    for i in range(1, len(S)):
        if s_query <= S[i]:
            denom = max(S[i] - S[i - 1], 1e-9)
            t = (s_query - S[i - 1]) / denom
            return float(values[i - 1] + t * (values[i] - values[i - 1]))
    return float(values[-1])


def _interp_latlon(
    s_query: float, S: Sequence[float], geometry: Sequence[Any]
) -> tuple[float, float]:
    if not geometry:
        return 0.0, 0.0
    if not S or len(S) != len(geometry):
        # fall back to endpoints
        p = geometry[0] if s_query <= 0 else geometry[-1]
        return float(getattr(p, "lat", 0.0)), float(getattr(p, "lon", 0.0))
    if s_query <= S[0]:
        p = geometry[0]
        return float(p.lat), float(p.lon)
    if s_query >= S[-1]:
        p = geometry[-1]
        return float(p.lat), float(p.lon)
    for i in range(1, len(S)):
        if s_query <= S[i]:
            denom = max(S[i] - S[i - 1], 1e-9)
            t = (s_query - S[i - 1]) / denom
            a, b = geometry[i - 1], geometry[i]
            return (
                float(a.lat + t * (b.lat - a.lat)),
                float(a.lon + t * (b.lon - a.lon)),
            )
    p = geometry[-1]
    return float(p.lat), float(p.lon)


@dataclass
class _LightPlan:
    s_m: float
    is_red: bool
    stop_duration_s: float
    cleared: bool = False
    waited_s: float = 0.0


def _speed_envelope(corridor: SpatialCorridor) -> list[float]:
    """Prefer V_envelope when populated; else legacy V_limite."""
    env = list(corridor.V_envelope or [])
    if env:
        return env
    return list(corridor.V_limite or [])


def _plan_lights(
    corridor: SpatialCorridor,
    *,
    seed: int | None,
    tls_cycle_s: float,
    tls_green_s: float,
    V: Sequence[float],
    tls_override: str = "auto",
) -> list[_LightPlan]:
    """Conditional TLS.

    Priority:
    1. ``tls_override`` force all lights green_wave / stochastic
    2. Explicit ``FeuMeta.tls_mode`` (from spatial assign or UI)
    3. Fallback: primary/trunk + spacing ≥ 500 m → green wave, else stochastic
    """
    cycle = max(float(tls_cycle_s), 1.0)
    green = max(0.0, min(float(tls_green_s), cycle))
    S = list(corridor.S or [])
    override = (tls_override or "auto").strip().lower()

    metas: list[FeuMeta] = list(corridor.feux_meta or [])
    if not metas:
        metas = [
            FeuMeta(s_m=float(s), highway=None, tls_mode="stochastic")
            for s in (corridor.S_feux or [])
        ]

    plans: list[_LightPlan] = []
    base_seed = 0 if seed is None else int(seed)
    prev_s: float | None = None

    for meta in sorted(metas, key=lambda m: float(m.s_m)):
        s_m = float(meta.s_m)
        highway = (meta.highway or "").strip().lower() or None
        spacing_ok = prev_s is None or (s_m - prev_s) >= ARTERIAL_MIN_SPACING_M

        if override == "green_wave":
            use_green_wave = True
        elif override == "stochastic":
            use_green_wave = False
        elif meta.tls_mode == "green_wave":
            use_green_wave = True
        elif meta.tls_mode == "stochastic":
            use_green_wave = False
        else:
            use_green_wave = highway in ARTERIAL_HIGHWAYS and spacing_ok

        v_local = max(_interp(s_m, S, V) if S and V else 1.0, 1.0)

        if use_green_wave:
            offset = (s_m / v_local) % cycle
        else:
            pos_key = int(round(s_m * 1000.0)) & 0xFFFFFFFF
            local_rng = random.Random((base_seed ^ pos_key ^ 0xA5A5A5A5) & 0xFFFFFFFF)
            offset = local_rng.random() * cycle

        phase = offset % cycle
        is_red = phase >= green
        stop_dur = max(cycle - phase, 1.0) if is_red else 0.0
        plans.append(_LightPlan(s_m=s_m, is_red=is_red, stop_duration_s=stop_dur))
        prev_s = s_m

    return plans


def _braking_distance_m(v: float, b_comf: float) -> float:
    """Approximate comfortable stopping distance (m)."""
    b = max(float(b_comf), 0.5)
    return max(v * v / (2.0 * b), 25.0)


def _plan_scheduled_stops(corridor: SpatialCorridor) -> list[_LightPlan]:
    """Mandatory dwells at intermediate waypoints (fixed duration, not Monte-Carlo)."""
    plans: list[_LightPlan] = []
    for stop in corridor.scheduled_stops or []:
        dur = float(stop.stop_duration_s or 0.0)
        if dur <= 0:
            continue
        # Skip stops too close to start/end
        s_end = float(corridor.S[-1]) if corridor.S else 0.0
        if float(stop.s_m) < 5.0 or float(stop.s_m) > s_end - 5.0:
            continue
        plans.append(
            _LightPlan(
                s_m=float(stop.s_m),
                is_red=True,
                stop_duration_s=dur,
            )
        )
    return plans


def _merge_stop_plans(
    lights: list[_LightPlan], scheduled: list[_LightPlan]
) -> list[_LightPlan]:
    """Combine TLS Monte-Carlo and waypoint stops; waypoint wins within 25 m."""
    merged = list(scheduled)
    for light in lights:
        if not light.is_red or light.stop_duration_s <= 0:
            continue
        near_scheduled = any(abs(light.s_m - s.s_m) < 25.0 for s in scheduled)
        if near_scheduled:
            continue
        merged.append(light)
    merged.sort(key=lambda p: p.s_m)
    return merged


def _apply_jerk_limit(
    a_cmd: float,
    a_prev: float,
    jerk_accel: float,
    dt: float,
    *,
    jerk_brake: float = 0.0,
) -> float:
    """Rate-limit longitudinal accel (asymmetric accel / brake jerk allowed)."""
    if dt <= 0.0:
        return a_cmd
    da = a_cmd - a_prev
    if da >= 0.0:
        if jerk_accel <= 0.0:
            return a_cmd
        return a_prev + min(da, jerk_accel * dt)
    jb = jerk_brake if jerk_brake > 0.0 else jerk_accel
    if jb <= 0.0:
        return a_cmd
    return a_prev - min(-da, jb * dt)


def _idm_accel(
    v: float,
    v0: float,
    gap: float | None,
    v_lead: float,
    params: IDMParams,
) -> float:
    """Classic IDM acceleration (m/s²). ``gap=None`` → free road."""
    v0 = max(v0, 0.1)
    v = max(v, 0.0)
    free = 1.0 - (v / v0) ** DELTA
    if gap is None or gap > 1e6:
        return params.a_max * free
    gap = max(gap, 0.1)
    dv = v - v_lead
    s_star = params.s0 + max(
        0.0,
        v * params.T
        + (v * dv) / (2.0 * math.sqrt(max(params.a_max * params.b_comf, 1e-6))),
    )
    return params.a_max * (free - (s_star / gap) ** 2)


def _scan_horizon_m(v: float, T_h: float) -> float:
    """Look-ahead distance: D = v · T_h (Gemini macroscopic UI)."""
    return max(0.0, float(v)) * max(0.0, float(T_h))


def _kinematic_horizon_m(v: float, T: float, b_comf: float) -> float:
    """Legacy comfortable stopping horizon: D = v·T + v²/(2|b|)."""
    vv = max(0.0, float(v))
    b = max(abs(float(b_comf)), 0.3)
    t = max(float(T), 0.0)
    return vv * t + (vv * vv) / (2.0 * b)


def _critical_envelope_leader(
    s: float,
    v: float,
    S: Sequence[float],
    V: Sequence[float],
    D_horizon: float,
    *,
    speed_factor: float = 1.0,
    step_m: float = HORIZON_SCAN_STEP_M,
) -> tuple[float, float] | None:
    """Scan V_envelope on [s, s+D]; return (L_critique, v_lead) for strongest brake.

    Critical point maximises required mean deceleration
    a_req = (v_lead² − v²) / (2L)  (most negative).
    """
    D = max(0.0, float(D_horizon))
    if D < 2.0 or v < 0.3 or not S or not V:
        return None
    sf = max(0.05, float(speed_factor))
    best_a = 0.0
    best: tuple[float, float] | None = None
    step = max(1.0, float(step_m))
    L = step
    while L <= D + 1e-9:
        v_lead = max(0.0, _interp(s + L, S, V) * sf)
        a_req = (v_lead * v_lead - v * v) / (2.0 * L)
        if a_req < best_a:
            best_a = a_req
            best = (L, v_lead)
        L += step
    # Also evaluate corridor vertices inside the horizon
    for i, si in enumerate(S):
        L = float(si) - s
        if L < 1.0:
            continue
        if L > D:
            break
        v_lead = max(0.0, float(V[min(i, len(V) - 1)]) * sf)
        a_req = (v_lead * v_lead - v * v) / (2.0 * L)
        if a_req < best_a:
            best_a = a_req
            best = (L, v_lead)
    if best is None or best_a >= HORIZON_BRAKE_EPS:
        return None
    return best


def _preview_brake_accel(
    s: float,
    v: float,
    S: Sequence[float],
    V: Sequence[float],
    alpha: Sequence[float],
    b_comf: float,
    *,
    T_look_s: float = PREVIEW_T_LOOK_S,
    step_m: float = PREVIEW_STEP_M,
    speed_factor: float = 1.0,
) -> float:
    """P2 — MPC-lite preview braking on `[s, s + v·T_look]`.

    For each s' > s in the preview horizon, compute the **maximum v achievable
    NOW** so that comfortable braking (b_comf) still hits V_env(s'), accounting
    for **gravity assist** (mean α on the segment [s, s']):

        v_max(s')² = V_env(s')² − 2·(b_comf + g·sin(mean_α))·(s' − s)

    Return the required accel `a_brake = (v_target² − v²) / (2·(s' − s))` for the
    tightest constraint. `0.0` if no preview braking is needed.

    Gravity assist means a descent (α<0) **increases** required braking effort
    (numerator grows), while a climb reduces it — physically correct even
    though the outer solver adds `−g·sin(α)` to the free accel too.
    """
    D = max(0.0, float(v) * max(0.0, float(T_look_s)))
    if D < 2.0 or v < 0.5 or not S or not V:
        # No constraint — caller must NOT treat this as "force coast".
        return float("inf")
    b = max(0.3, float(b_comf))
    sf = max(0.05, float(speed_factor))
    step = max(1.0, float(step_m))
    a_needed = float("inf")  # only track most-negative braking request
    L = step
    while L <= D + 1e-9:
        s_p = s + L
        v_env = max(0.0, _interp(s_p, S, V) * sf)
        # mean α on [s, s_p]: single sample at midpoint is enough for kinematic
        alpha_mid = _interp(s + 0.5 * L, S, alpha) if alpha else 0.0
        # b_eff: uphill (α>0) helps braking, downhill (α<0) hurts.
        b_eff = b + G_EARTH * math.sin(alpha_mid)
        b_eff = max(0.1, b_eff)  # never let downhill totally cancel confort brake
        # Max v_now such that (v_now²) can decay to v_env² within L at b_eff
        v_now_max_sq = v_env * v_env + 2.0 * b_eff * L
        if v_now_max_sq <= 0.0:
            v_target = 0.0
        else:
            v_target = math.sqrt(v_now_max_sq)
        if v < v_target:
            L += step
            continue
        a_req = (v_target * v_target - v * v) / (2.0 * L)
        if a_req < a_needed:
            a_needed = a_req
        L += step
    return a_needed


def frames_to_profile(
    frames: Sequence[SimulationFrame | dict[str, Any]],
    *,
    status: str = "completed",
    safety: dict[str, Any] | None = None,
) -> ConsolidatedProfile:
    """Build a profile from frames.

    ``traffic_source`` / ``warnings`` are attached by ``simulation_manager`` when
    consolidating a full run — not here.
    """
    time: list[float] = []
    velocity: list[float] = []
    position: list[float] = []
    acceleration: list[float] = []
    slope: list[float] = []
    for fr in frames:
        if isinstance(fr, SimulationFrame):
            time.append(float(fr.t))
            velocity.append(max(0.0, float(fr.v)))
            position.append(float(fr.s))
            acceleration.append(float(fr.a))
            slope.append(float(fr.alpha))
        else:
            time.append(float(fr.get("t", 0.0)))
            velocity.append(max(0.0, float(fr.get("v", 0.0))))
            position.append(float(fr.get("s", 0.0)))
            acceleration.append(float(fr.get("a", 0.0)))
            slope.append(float(fr.get("alpha", 0.0)))
    if not time:
        return ConsolidatedProfile(
            time=[0.0],
            velocity=[0.0],
            position=[0.0],
            acceleration=[0.0],
            slope=[0.0],
            total_duration_s=0.0,
            average_speed_kmh=0.0,
            status=status,  # type: ignore[arg-type]
        )
    duration = float(time[-1] - time[0]) if len(time) > 1 else 0.0
    dist = max(0.0, position[-1] - position[0])
    avg_kmh = (dist / duration * 3.6) if duration > 1e-6 else 0.0
    extra: dict[str, Any] = {}
    if safety:
        for key in (
            "max_abs_accel",
            "max_abs_accel_g",
            "markov_gate_fraction",
            "clip_hit_count",
            "rpa",
            "stops",
            "stop_time_ratio",
        ):
            if key in safety and safety[key] is not None:
                extra[key] = safety[key]
    return ConsolidatedProfile(
        time=time,
        velocity=velocity,
        position=position,
        acceleration=acceleration,
        slope=slope,
        total_duration_s=duration,
        average_speed_kmh=avg_kmh,
        status=status,  # type: ignore[arg-type]
        **extra,
    )


class IDMSolver:
    """Euler-integrated Intelligent Driver Model on a ``SpatialCorridor``."""

    def __init__(
        self,
        corridor: SpatialCorridor,
        driver_profile: DriverProfile | str = DriverProfile.NORMAL,
        *,
        seed: int | None = None,
        dt: float = DT,
        max_speed_mps: float | None = None,
        param_overrides: dict[str, float] | None = None,
        driver_zones: list[dict[str, Any]] | None = None,
        tls_cycle_s: float = DEFAULT_TLS_CYCLE_S,
        tls_green_s: float = DEFAULT_TLS_GREEN_S,
        tls_override: str = "auto",
        enable_markov: bool = False,
    ) -> None:
        self.corridor = corridor
        self.profile, self.params = resolve_profile(
            driver_profile, overrides=param_overrides
        )
        self.driver_zones = list(driver_zones or [])
        self.seed = seed
        self.dt = float(dt)
        self.max_speed_mps = (
            float(max_speed_mps) if max_speed_mps is not None and max_speed_mps > 0 else None
        )
        self.tls_cycle_s = float(tls_cycle_s)
        self.tls_green_s = float(tls_green_s)
        self.tls_override = (tls_override or "auto").strip().lower()
        self.enable_markov = bool(enable_markov)
        self._rng = random.Random(seed)
        self._markov = MarkovNoiseGenerator(self.profile)
        self.last_safety: dict[str, Any] = {}

    def solve(self) -> ConsolidatedProfile:
        frames = self.generate_frames()
        return frames_to_profile(
            frames, status="completed", safety=self.last_safety
        )

    def generate_frames(self) -> list[SimulationFrame]:
        S = list(self.corridor.S or [])
        V = _speed_envelope(self.corridor)
        alpha = list(self.corridor.alpha or [])
        geom = list(self.corridor.geometry or [])
        if not S:
            self.last_safety = {}
            return [
                SimulationFrame(
                    t=0.0, v=0.0, a=0.0, s=0.0, alpha=0.0, density=0.0, vehicles=[]
                )
            ]

        s_end = float(S[-1])
        if s_end <= 0:
            a0 = float(alpha[0]) if alpha else 0.0
            self.last_safety = {}
            return [
                SimulationFrame(
                    t=0.0, v=0.0, a=0.0, s=0.0, alpha=a0, density=0.0, vehicles=[]
                )
            ]

        lights = _merge_stop_plans(
            _plan_lights(
                self.corridor,
                seed=self.seed,
                tls_cycle_s=self.tls_cycle_s,
                tls_green_s=self.tls_green_s,
                V=V,
                tls_override=self.tls_override,
            ),
            _plan_scheduled_stops(self.corridor),
        )
        params = self.params

        s = 0.0
        v = 0.0
        t = 0.0
        a_prev = 0.0
        stall_steps = 0
        frames: list[SimulationFrame] = []
        gate_steps = 0
        motion_steps = 0
        clip_hits = 0
        max_abs_a = 0.0

        def snapshot(a: float) -> SimulationFrame:
            lat, lon = _interp_latlon(s, S, geom)
            return SimulationFrame(
                t=t,
                v=max(0.0, v),
                a=a,
                s=s,
                alpha=_interp(s, S, alpha),
                density=0.0,
                vehicles=[
                    VehicleSnapshot(
                        id="ego", lat=lat, lon=lon, speed_mps=max(0.0, v), is_ego=True
                    )
                ],
                tls_state=None,
            )

        frames.append(snapshot(0.0))

        stop_zone_m = VEHICLE_LENGTH_M + params.s0 + 5.0
        finish_eps_m = 0.5

        for _ in range(MAX_STEPS):
            s_before = s
            remaining = s_end - s
            if remaining <= finish_eps_m:
                s = s_end
                frames.append(snapshot(0.0))
                break

            waiting = False
            for light in lights:
                if light.cleared or not light.is_red:
                    continue
                dist_to_light = light.s_m - s
                in_zone = -2.0 <= dist_to_light <= stop_zone_m
                if in_zone and v < 0.8:
                    if light.waited_s < light.stop_duration_s:
                        light.waited_s += self.dt
                        waiting = True
                        v = 0.0
                        a = 0.0
                        a_prev = 0.0
                        t += self.dt
                        fr = snapshot(a)
                        fr.tls_state = "r"
                        frames.append(fr)
                        break
                    light.cleared = True
            if waiting:
                continue

            v_lim = max(0.0, _interp(s, S, V))
            params = _params_for_s(self.params, self.driver_zones, s)
            v_des = max(0.1, v_lim * params.speed_factor)
            if self.max_speed_mps is not None:
                v_des = min(v_des, self.max_speed_mps)

            gap: float | None = None
            v_lead = 0.0
            tls_state: str | None = None
            delta_s = float("inf")
            for light in lights:
                if light.cleared or not light.is_red:
                    continue
                if light.s_m >= s - 1.0:
                    gap = max(light.s_m - s - VEHICLE_LENGTH_M, params.s0 * 0.5)
                    v_lead = 0.0
                    tls_state = "r"
                    delta_s = min(delta_s, max(light.s_m - s, 0.0))
                    break

            # Scan horizon (Gemini UI): D = v · T_h
            # Inject IDM virtual leader at L requiring strongest brake.
            if remaining > 30.0 and stall_steps < 15:
                D_h = _scan_horizon_m(v, params.T_h)
                crit = _critical_envelope_leader(
                    s,
                    v,
                    S,
                    V,
                    D_h,
                    speed_factor=params.speed_factor,
                )
                if crit is not None:
                    L_c, v_lead_env = crit
                    delta_s = min(delta_s, L_c)
                    gap_env = max(L_c, 0.1)
                    a_tls = _idm_accel(v, v_des, gap, v_lead, params)
                    a_env = _idm_accel(v, v_des, gap_env, v_lead_env, params)
                    if gap is None or a_env < a_tls:
                        gap, v_lead = gap_env, v_lead_env

            # Unstick sooner on long routes; never block the last 150 m
            if stall_steps >= 15 or remaining < 150.0:
                gap = None
                tls_state = None
                delta_s = float("inf")

            a_idm = _idm_accel(v, v_des, gap, v_lead, params)

            # P1 — dynamic grade coupling: −g·sin(α(s))
            #   α > 0  (climb)   → subtract (car naturally slows)
            #   α < 0  (descent) → add     (car naturally speeds up)
            alpha_s = _interp(s, S, alpha) if alpha else 0.0
            a_grade = -G_EARTH * math.sin(alpha_s)
            a_dyn = a_idm + a_grade

            # P2 — MPC-lite preview braking (curve + descent lookahead).
            # Runs on top of the T_h leader scan: the preview horizon
            # (v · T_look) is longer than the collision leader scan and
            # accounts for gravity assist, catching hairpins in descent
            # long before the C¹ envelope alone would.
            if remaining > 30.0 and stall_steps < 15:
                a_preview = _preview_brake_accel(
                    s,
                    v,
                    S,
                    V,
                    alpha,
                    params.b_comf,
                    T_look_s=PREVIEW_T_LOOK_S,
                    step_m=PREVIEW_STEP_M,
                    speed_factor=params.speed_factor,
                )
                # Preview returns +inf when unconstrained. Only clamp when it
                # actually demands braking — never replace a positive a_idm
                # with 0.0 (that bug killed all free-road acceleration).
                if math.isfinite(a_preview) and a_preview < a_dyn:
                    a_dyn = a_preview

            d_brake = _braking_distance_m(v, params.b_comf)
            is_critical = (delta_s < d_brake) or (a_dyn <= -1.0)

            a_noise = 0.0
            if self.enable_markov:
                a_noise = self._markov.sample_noise(
                    current_v=v,
                    current_a_idm=a_dyn,
                    is_critical_braking=is_critical,
                    rng=self._rng,
                )

            # AVL / BCB mechanical clamps: a ∈ [-b_comf, a_max], then asymmetric jerk.
            a_min = -params.b_comf
            a_max = params.a_max
            raw = a_dyn + a_noise
            a_clipped = max(a_min, min(a_max, raw))
            a_final = _apply_jerk_limit(
                a_clipped,
                a_prev,
                params.jerk_max,
                self.dt,
                jerk_brake=params.jerk_brake_max,
            )
            if abs(a_clipped - raw) > 1e-9 or abs(a_final - a_clipped) > 1e-9:
                clip_hits += 1
            if is_critical:
                gate_steps += 1
            motion_steps += 1
            max_abs_a = max(max_abs_a, abs(a_final))

            v_next = max(0.0, v + a_final * self.dt)
            # Near the finish, keep a minimum crawl so we always reach s_end
            if remaining < 80.0:
                v_next = max(v_next, min(2.0, max(0.5, v_des)))
            v_next = min(v_next, max(v_des * 1.05, v_des + 2.0, 2.5))
            s_next = min(s_end, s + v_next * self.dt)

            v = v_next
            s = s_next
            a_prev = a_final
            t += self.dt

            if s - s_before < 0.05 and v < 0.5:
                stall_steps += 1
            else:
                stall_steps = 0

            fr = snapshot(a_final)
            fr.tls_state = tls_state
            frames.append(fr)

            if s >= s_end - finish_eps_m:
                s = s_end
                frames[-1] = snapshot(0.0)
                break
        else:
            # MAX_STEPS exhausted without arrival — free-flow coast to the end
            for _ in range(int(max(s_end, 1.0) / max(self.dt, 0.1)) + 100):
                if s >= s_end - finish_eps_m:
                    s = s_end
                    v = 0.0
                    frames.append(snapshot(0.0))
                    break
                v_lim = max(1.0, _interp(s, S, V))
                v_des = max(1.0, v_lim * params.speed_factor)
                if self.max_speed_mps is not None:
                    v_des = min(v_des, self.max_speed_mps)
                a_idm = _idm_accel(v, v_des, None, 0.0, params)
                # P1 — grade also on coast tail
                alpha_s = _interp(s, S, alpha) if alpha else 0.0
                a_final = a_idm - G_EARTH * math.sin(alpha_s)
                a_final = max(-params.b_comf, min(params.a_max, a_final))
                a_final = _apply_jerk_limit(
                    a_final,
                    a_prev,
                    params.jerk_max,
                    self.dt,
                    jerk_brake=params.jerk_brake_max,
                )
                v = max(0.5, v + a_final * self.dt)
                s = min(s_end, s + v * self.dt)
                t += self.dt
                a_prev = a_final
                frames.append(snapshot(a_final))

        from app.services.profile_metrics import (
            profile_kpis,
            relative_positive_acceleration,
        )
        import numpy as np

        vel = np.array([f.v for f in frames], dtype=float)
        tim = np.array([f.t for f in frames], dtype=float)
        acc = np.array([f.a for f in frames], dtype=float)
        rpa = relative_positive_acceleration(tim, vel, acc)
        ktmp = profile_kpis(
            {
                "time": tim.tolist(),
                "velocity": vel.tolist(),
                "position": [f.s for f in frames],
                "acceleration": acc.tolist(),
            }
        )
        self.last_safety = {
            "max_abs_accel": float(max_abs_a),
            "max_abs_accel_g": float(max_abs_a / G_EARTH),
            "markov_gate_fraction": (
                float(gate_steps) / float(motion_steps) if motion_steps else 0.0
            ),
            "clip_hit_count": int(clip_hits),
            "rpa": float(rpa),
            "stops": int(ktmp["stops"]),
            "stop_time_ratio": float(ktmp["stop_time_ratio"]),
        }
        return frames
