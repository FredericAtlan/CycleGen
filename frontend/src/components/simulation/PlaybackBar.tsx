"use client";

import type { CyclePlayback, PlaybackSpeed } from "@/hooks/useCyclePlayback";
import { PLAYBACK_SPEEDS } from "@/hooks/useCyclePlayback";

type PlaybackBarProps = {
  playback: CyclePlayback;
  className?: string;
};

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export default function PlaybackBar({ playback, className = "" }: PlaybackBarProps) {
  if (!playback.ready) return null;

  const {
    playing,
    speed,
    t,
    s,
    v,
    duration,
    toggle,
    reset,
    seekT,
    setSpeed,
  } = playback;

  return (
    <div
      className={`flex flex-wrap items-center gap-2 border-t border-slate-200 bg-white/95 px-2.5 py-1.5 shadow-[0_-4px_12px_rgba(15,23,42,0.04)] backdrop-blur ${className}`}
      role="group"
      aria-label="Lecture du cycle"
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "k") {
          e.preventDefault();
          toggle();
        } else if (e.key === "Home") {
          e.preventDefault();
          reset();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          seekT(Math.max(0, t - 1));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          seekT(Math.min(duration, t + 1));
        }
      }}
    >
      <button
        type="button"
        onClick={toggle}
        className="inline-flex h-7 min-w-[2.25rem] items-center justify-center rounded-md bg-brand px-2 text-[11px] font-bold text-white hover:bg-brand-dark"
        title={playing ? "Pause (Espace)" : "Lecture (Espace)"}
        aria-label={playing ? "Pause" : "Lecture"}
        aria-pressed={playing}
      >
        <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
      </button>
      <button
        type="button"
        onClick={reset}
        className="inline-flex h-7 items-center justify-center rounded-md border border-slate-200 bg-white px-2 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
        title="Revenir au départ (Home)"
        aria-label="Revenir au départ"
      >
        <span aria-hidden>↺</span>
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 tabular-nums text-[10px] font-semibold text-slate-600">
          {fmtTime(t)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.001)}
          step={0.1}
          value={clampSeek(t, duration)}
          onChange={(e) => {
            if (playing) playback.pause();
            seekT(Number(e.target.value));
          }}
          className="h-1.5 min-w-0 flex-1 accent-brand"
          aria-label="Position temporelle"
          aria-valuetext={`${fmtTime(t)} · ${(s / 1000).toFixed(2)} km · ${(v * 3.6).toFixed(0)} km/h`}
        />
        <span className="shrink-0 tabular-nums text-[10px] text-slate-400">
          {fmtTime(duration)}
        </span>
      </div>

      <div
        className="flex items-center gap-0.5 rounded-md border border-slate-200 bg-slate-50 p-0.5"
        role="group"
        aria-label="Vitesse de lecture"
      >
        {PLAYBACK_SPEEDS.map((sp) => (
          <button
            key={sp}
            type="button"
            onClick={() => setSpeed(sp as PlaybackSpeed)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
              speed === sp
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-white"
            }`}
            title={`Vitesse ×${sp}`}
            aria-label={`Vitesse ×${sp}`}
            aria-pressed={speed === sp}
          >
            ×{sp}
          </button>
        ))}
      </div>

      <div className="hidden shrink-0 items-center gap-2 text-[10px] tabular-nums text-slate-500 sm:flex">
        <span>
          s{" "}
          <span className="font-semibold text-slate-800">
            {(s / 1000).toFixed(2)}
          </span>{" "}
          km
        </span>
        <span>
          v{" "}
          <span className="font-semibold text-slate-800">
            {(v * 3.6).toFixed(0)}
          </span>{" "}
          km/h
        </span>
      </div>
    </div>
  );
}

function clampSeek(t: number, duration: number): number {
  if (!Number.isFinite(t)) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(duration, t));
}
