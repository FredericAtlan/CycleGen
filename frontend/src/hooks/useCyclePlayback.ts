/** Client-side playhead over a finished ConsolidatedProfile (post-IDM replay). */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsolidatedProfile } from "@/lib/types";

export const PLAYBACK_SPEEDS = [1, 5, 10, 20, 50] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export type CyclePlayback = {
  playing: boolean;
  speed: PlaybackSpeed;
  /** Current cycle time (s). */
  t: number;
  /** Current curvilinear abscissa (m). */
  s: number;
  /** Nearest sample index. */
  index: number;
  /** Vehicle speed at playhead (m/s). */
  v: number;
  duration: number;
  ready: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  reset: () => void;
  seekT: (t: number) => void;
  seekS: (s_m: number) => void;
  setSpeed: (speed: PlaybackSpeed) => void;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Largest i with time[i] <= t (or 0). */
function indexAtTime(time: number[], t: number): number {
  if (time.length === 0) return 0;
  if (t <= time[0]) return 0;
  if (t >= time[time.length - 1]) return time.length - 1;
  let lo = 0;
  let hi = time.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Nearest index by curvilinear S (assumes position monotonic). */
function indexAtS(position: number[], s: number): number {
  if (position.length === 0) return 0;
  if (s <= position[0]) return 0;
  if (s >= position[position.length - 1]) return position.length - 1;
  let lo = 0;
  let hi = position.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (position[mid] <= s) lo = mid;
    else hi = mid;
  }
  const dLo = Math.abs(position[lo] - s);
  const dHi = Math.abs(position[hi] - s);
  return dLo <= dHi ? lo : hi;
}

function sampleAt(
  profile: ConsolidatedProfile,
  t: number
): { index: number; s: number; v: number } {
  const time = profile.time;
  const i = indexAtTime(time, t);
  const s = profile.position[i] ?? 0;
  const v = profile.velocity[i] ?? 0;
  return { index: i, s, v };
}

export function useCyclePlayback(
  profile: ConsolidatedProfile | null | undefined,
  /** Simulation id or other stable identity — forces playhead reset when it changes. */
  identity?: string | null
): CyclePlayback {
  const ready = !!profile && profile.time.length > 1;
  const duration = ready
    ? profile!.time[profile!.time.length - 1] ?? 0
    : 0;

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState<PlaybackSpeed>(10);
  const [t, setT] = useState(0);

  const playingRef = useRef(playing);
  const speedRef = useRef(speed);
  const tRef = useRef(t);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const profileRef = useRef(profile);

  playingRef.current = playing;
  speedRef.current = speed;
  tRef.current = t;
  profileRef.current = profile;

  const derived = useMemo(() => {
    if (!ready || !profile) return { index: 0, s: 0, v: 0 };
    return sampleAt(profile, t);
  }, [ready, profile, t]);

  const stopRaf = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastTsRef.current = null;
  }, []);

  const tick = useCallback((now: number) => {
    const p = profileRef.current;
    if (!p || p.time.length < 2 || !playingRef.current) {
      stopRaf();
      setPlaying(false);
      return;
    }
    const last = lastTsRef.current;
    lastTsRef.current = now;
    if (last == null) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    const dtReal = Math.min(0.25, (now - last) / 1000);
    const nextT = tRef.current + dtReal * speedRef.current;
    const end = p.time[p.time.length - 1] ?? 0;
    if (nextT >= end) {
      tRef.current = end;
      setT(end);
      setPlaying(false);
      stopRaf();
      return;
    }
    tRef.current = nextT;
    setT(nextT);
    rafRef.current = requestAnimationFrame(tick);
  }, [stopRaf]);

  const play = useCallback(() => {
    const p = profileRef.current;
    if (!p || p.time.length < 2) return;
    const end = p.time[p.time.length - 1] ?? 0;
    // Restart from 0 when already at end.
    if (tRef.current >= end - 1e-6) {
      tRef.current = 0;
      setT(0);
    }
    setPlaying(true);
  }, []);

  const pause = useCallback(() => {
    setPlaying(false);
    stopRaf();
  }, [stopRaf]);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  const reset = useCallback(() => {
    stopRaf();
    setPlaying(false);
    tRef.current = 0;
    setT(0);
  }, [stopRaf]);

  const seekT = useCallback(
    (next: number) => {
      const p = profileRef.current;
      if (!p || p.time.length < 2) return;
      const end = p.time[p.time.length - 1] ?? 0;
      const clamped = clamp(next, 0, end);
      tRef.current = clamped;
      setT(clamped);
    },
    []
  );

  const seekS = useCallback((s_m: number) => {
    const p = profileRef.current;
    if (!p || p.position.length < 2) return;
    const i = indexAtS(p.position, s_m);
    const nextT = p.time[i] ?? 0;
    tRef.current = nextT;
    setT(nextT);
  }, []);

  const setSpeed = useCallback((sp: PlaybackSpeed) => {
    setSpeedState(sp);
    speedRef.current = sp;
  }, []);

  // Drive RAF while playing.
  useEffect(() => {
    if (!playing || !ready) {
      stopRaf();
      return;
    }
    lastTsRef.current = null;
    rafRef.current = requestAnimationFrame(tick);
    return stopRaf;
  }, [playing, ready, tick, stopRaf]);

  // Reset playhead when profile identity changes (sim id + shape fingerprint).
  const profileKey = ready
    ? [
        identity ?? "",
        profile!.time.length,
        profile!.total_duration_s,
        profile!.position[profile!.position.length - 1],
        profile!.average_speed_kmh,
        profile!.status,
        profile!.velocity[0] ?? 0,
      ].join(":")
    : "";
  useEffect(() => {
    stopRaf();
    setPlaying(false);
    tRef.current = 0;
    setT(0);
  }, [profileKey, stopRaf]);

  return {
    playing,
    speed,
    t,
    s: derived.s,
    index: derived.index,
    v: derived.v,
    duration,
    ready,
    play,
    pause,
    toggle,
    reset,
    seekT,
    seekS,
    setSpeed,
  };
}
