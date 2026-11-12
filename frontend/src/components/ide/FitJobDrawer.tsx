"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getRouteStudioFitJob,
  submitRouteStudioFitJob,
  type RouteStudioFitJobStatus,
} from "@/lib/api";
import { completePhysics } from "@/lib/driverPresets";
import { getDriver } from "@/lib/driverLibrary";
import { listSavedCycles } from "@/lib/cycleLibrary";
import { useWorkspaceStore } from "@/lib/workspaceStore";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Dense drawer — async Route Studio geometry-lock fit (poll task_id).
 * Never blocks UI on a sync long POST.
 */
export default function FitJobDrawer({ open, onClose }: Props) {
  const corridor = useWorkspaceStore((s) => s.geometry.corridor);
  const driverId = useWorkspaceStore((s) => s.config.driverId);
  const pushConsole = useWorkspaceStore((s) => s.pushConsole);
  const [cycleId, setCycleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<RouteStudioFitJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activePollTaskIdRef = useRef<string | null>(null);
  const pollFailStreakRef = useRef(0);

  const MAX_POLL_FAIL_STREAK = 4;

  const cycles = listSavedCycles().filter((c) => c.resultAvailable);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    activePollTaskIdRef.current = null;
    pollFailStreakRef.current = 0;
  }, []);

  const close = useCallback(() => {
    stopPoll();
    setBusy(false);
    onClose();
  }, [stopPoll, onClose]);

  useEffect(() => {
    if (!open) {
      stopPoll();
      setBusy(false);
    }
    return () => stopPoll();
  }, [open, stopPoll]);

  const startPoll = useCallback(
    (taskId: string) => {
      stopPoll();
      activePollTaskIdRef.current = taskId;
      pollFailStreakRef.current = 0;

      const tick = () => {
        const tid = activePollTaskIdRef.current;
        if (!tid) return;

        void getRouteStudioFitJob(tid)
          .then((st) => {
            if (activePollTaskIdRef.current !== tid) return;
            pollFailStreakRef.current = 0;
            setJob(st);
            if (st.status === "completed" || st.status === "failed") {
              if (activePollTaskIdRef.current !== tid) return;
              stopPoll();
              setBusy(false);
              pushConsole(
                st.status === "completed"
                  ? `fit · done ${st.message}`
                  : `fit · failed ${st.error ?? st.message}`
              );
            }
          })
          .catch((e) => {
            if (activePollTaskIdRef.current !== tid) return;
            pollFailStreakRef.current += 1;
            if (pollFailStreakRef.current >= MAX_POLL_FAIL_STREAK) {
              stopPoll();
              setBusy(false);
              setError(e instanceof Error ? e.message : String(e));
            }
          });
      };

      tick();
      pollRef.current = setInterval(tick, 600);
    },
    [stopPoll, pushConsole]
  );

  const submit = async () => {
    setError(null);
    if (!corridor) {
      setError("Pas de corridor — Recalculer corridor ou chargez un trajet d’abord");
      return;
    }
    const c = cycles.find((x) => x.id === cycleId);
    if (!c) {
      setError("Choisir une référence (cycle lib)");
      return;
    }
    setBusy(true);
    setJob(null);
    try {
      const d = driverId ? getDriver(driverId) : null;
      const phys = completePhysics(d?.physics ?? null);
      const res = await submitRouteStudioFitJob({
        corridor,
        t_ref: c.time,
        v_ref: c.velocity,
        driver_profile: d?.baseProfile ?? "Normal",
        driver_params: {
          a_max: phys.a_max,
          b_comf: phys.b_comf,
          speed_factor: phys.speed_factor,
          T: phys.T,
          T_h: phys.T_h,
          s0: phys.s0,
          jerk_max: phys.jerk_max,
          jerk_brake_max: phys.jerk_brake_max,
          pedal_tau_s: phys.pedal_tau_s ?? 0,
          vdes_tau_s: phys.vdes_tau_s ?? 0,
          descent_hold_gain: phys.descent_hold_gain ?? 0,
        },
      });
      pushConsole(`fit · submitted ${res.task_id}`);
      setJob({
        task_id: res.task_id,
        status: res.status,
        progress: 0,
        message: "queued",
        error: null,
      });
      startPoll(res.task_id);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!open) return null;

  const best = job?.result?.best;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      data-testid="fit-job-drawer"
      onClick={close}
    >
      <aside
        className="flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
          <div>
            <div className="text-[13px] font-semibold text-slate-900">
              Caler sur Route Studio
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              Ajuste le conducteur pour coller à une trace de référence (job
              async)
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="text-[12px] text-slate-500 hover:text-slate-900"
          >
            Fermer
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto p-3">
          <p className="text-[11px] text-slate-600">
            Corridor :{" "}
            <span className="font-mono tabular-nums">
              {corridor ? `${corridor.S.length} pts` : "aucun"}
            </span>
            {" · "}
            Conducteur :{" "}
            <span className="font-mono">{driverId ?? "—"}</span>
          </p>

          <label className="block text-[11px] text-slate-600">
            Cycle de référence
            <select
              value={cycleId}
              onChange={(e) => setCycleId(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-[11px] text-slate-800"
            >
              <option value="">—</option>
              {cycles.slice(0, 80).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="w-full rounded bg-slate-900 px-2 py-2 text-[12px] font-semibold text-white disabled:opacity-40"
          >
            {busy ? "Calcul en cours…" : "Lancer le calage"}
          </button>

          {error ? (
            <p className="font-mono text-[10px] text-red-600">{error}</p>
          ) : null}

          {job ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-2 font-mono text-[10px] tabular-nums text-slate-700">
              <div>
                {job.task_id} · {job.status} ·{" "}
                {(job.progress * 100).toFixed(0)}%
              </div>
              <div className="text-slate-500">{job.message}</div>
              {best ? (
                <div className="mt-2 space-y-0.5 border-t border-slate-200 pt-2">
                  <div>best={best.variant}</div>
                  <div>
                    RMSE={best.compare.rmse_v_kmh} · score=
                    {best.compare.fidelity_score} · osc={best.compare.osc}
                  </div>
                  <div>
                    ΔT%={best.compare.delta_duration_pct} · pedal_τ=
                    {best.params.pedal_tau_s ?? 0}
                  </div>
                </div>
              ) : null}
              {job.error ? (
                <div className="mt-1 text-red-600">{job.error}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
