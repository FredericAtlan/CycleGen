"use client";

import { useMemo } from "react";
import { getDriver, listDrivers } from "@/lib/driverLibrary";
import { getVehicle, listVehicles } from "@/lib/vehicleLibrary";
import { listSavedCycles } from "@/lib/cycleLibrary";
import { listSavedTrips } from "@/lib/tripStore";
import { useWorkspaceStore } from "@/lib/workspaceStore";
import DriverInspector from "./DriverInspector";
import RoadLawInspector from "./RoadLawInspector";
import VehicleInspector from "./VehicleInspector";

function Kv({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-2 border-b border-slate-100 py-1">
      <span className="font-mono text-[9px] uppercase tracking-wide text-slate-400">
        {k}
      </span>
      <span
        className={`font-mono text-[11px] tabular-nums ${
          danger ? "font-semibold text-red-600" : "text-slate-800"
        }`}
      >
        {v}
      </span>
    </div>
  );
}

export default function PropertyInspector() {
  const selection = useWorkspaceStore((s) => s.selection);
  const config = useWorkspaceStore((s) => s.config);
  const hoverIndex = useWorkspaceStore((s) => s.hoverIndex);
  const playheadIndex = useWorkspaceStore((s) => s.playheadIndex);

  const driver =
    selection.kind === "driver" && selection.id
      ? getDriver(selection.id) ??
        listDrivers().find((x) => x.id === selection.id) ??
        null
      : null;

  const vehicle =
    selection.kind === "vehicle" && selection.id
      ? getVehicle(selection.id) ??
        listVehicles().find((x) => x.id === selection.id) ??
        null
      : null;

  const body = useMemo(() => {
    if (!selection.kind || !selection.id) {
      return (
        <p className="p-3 text-[12px] leading-relaxed text-slate-600">
          Cliquez un élément à gauche (conducteur, véhicule, loi…).
          <br />
          <span className="text-[11px] text-slate-400">
            Nouveau conducteur depuis fichiers → menu Conducteur.
          </span>
        </p>
      );
    }
    if (
      selection.kind === "driver" ||
      selection.kind === "vehicle" ||
      selection.kind === "roadLaw"
    ) {
      return null;
    }
    if (selection.kind === "cycle") {
      const c = listSavedCycles().find((x) => x.id === selection.id);
      if (!c)
        return (
          <p className="p-3 font-mono text-[10px] text-red-600">
            Cycle introuvable
          </p>
        );
      const st = c.stats;
      return (
        <div className="space-y-0 p-2">
          <div className="mb-2 border-b border-slate-200 pb-2">
            <div className="text-[12px] font-semibold text-slate-900">
              {c.name}
            </div>
            <div className="font-mono text-[9px] text-slate-400">{c.id}</div>
          </div>
          <Kv k="distance" v={`${(st.distance_m / 1000).toFixed(2)} km`} />
          <Kv k="duration" v={`${(st.duration_s / 60).toFixed(1)} min`} />
          <Kv k="v_mean" v={`${st.v_mean_kmh.toFixed(1)} km/h`} />
          <Kv k="v_max" v={`${st.v_max_kmh.toFixed(1)} km/h`} />
          <Kv k="source" v={c.source.slice(0, 48)} />
        </div>
      );
    }
    if (selection.kind === "trip") {
      const t = listSavedTrips().find((x) => x.id === selection.id);
      if (!t)
        return (
          <p className="p-3 font-mono text-[10px] text-red-600">
            Trajet introuvable
          </p>
        );
      return (
        <div className="space-y-0 p-2">
          <div className="mb-2 text-[12px] font-semibold text-slate-900">
            {t.name}
          </div>
          <Kv k="A" v={t.departureLabel || "—"} />
          <Kv k="B" v={t.destinationLabel || "—"} />
          <Kv
            k="distance"
            v={
              t.distanceM != null
                ? `${(t.distanceM / 1000).toFixed(1)} km`
                : "—"
            }
          />
          <Kv k="profile" v={String(t.routingProfile)} />
        </div>
      );
    }
    return null;
  }, [selection]);

  return (
    <div
      data-testid="ide-property-inspector"
      className="flex h-full min-h-0 flex-col bg-white"
    >
      <div className="shrink-0 border-b border-slate-200 px-2.5 py-2">
        <div className="text-[12px] font-semibold text-slate-900">
          Paramètres
        </div>
        <div className="text-[10px] text-slate-400">
          Édition de la sélection
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {driver ? (
          <DriverInspector driver={driver} />
        ) : vehicle ? (
          <VehicleInspector vehicle={vehicle} />
        ) : selection.kind === "roadLaw" && selection.id ? (
          <RoadLawInspector lawId={selection.id} />
        ) : (
          body
        )}
      </div>
      <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-[9px] tabular-nums text-slate-500">
        cfg d={config.driverId?.slice(0, 12) ?? "—"} · v=
        {config.vehicleId?.slice(0, 12) ?? "—"} · law=
        {config.roadLawId?.slice(0, 12) ?? "—"} · hover=
        {hoverIndex ?? "—"} · play={playheadIndex ?? "—"}
      </div>
    </div>
  );
}
