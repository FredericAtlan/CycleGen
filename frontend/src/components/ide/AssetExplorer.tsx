"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listDrivers } from "@/lib/driverLibrary";
import { listVehicles } from "@/lib/vehicleLibrary";
import { listSavedCycles } from "@/lib/cycleLibrary";
import { listSavedTrips } from "@/lib/tripStore";
import {
  listRoadLawsAsync,
  listRoadLawsSync,
  type RoadLaw,
} from "@/lib/roadLawLibrary";
import {
  useWorkspaceStore,
  type AssetKind,
} from "@/lib/workspaceStore";
import { getDriver } from "@/lib/driverLibrary";
import { scheduleUpdateDynamics } from "@/lib/ideSim";

type SectionId = "drivers" | "vehicles" | "roadLaws" | "cycles" | "trips";

function Section({
  id,
  title,
  open,
  onToggle,
  children,
  count,
}: {
  id: SectionId;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  count: number;
}) {
  return (
    <div className="border-b border-slate-200" data-section={id}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between bg-slate-100/80 px-2.5 py-2 text-left text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
      >
        <span>
          {title}{" "}
          <span className="font-mono text-[10px] font-normal tabular-nums text-slate-400">
            {count}
          </span>
        </span>
        <span className="text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <ul className="relative z-[1] divide-y divide-slate-100">{children}</ul>
      ) : null}
    </div>
  );
}

function Row({
  kind,
  id,
  label,
  meta,
  selected,
  onSelect,
}: {
  kind: AssetKind;
  id: string;
  label: string;
  meta?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const testId = `ide-asset-row-${kind}-${id}`;

  return (
    <li className="relative isolate">
      <button
        type="button"
        onClick={onSelect}
        data-testid={testId}
        data-asset-kind={kind}
        data-asset-id={id}
        data-selected={selected ? "true" : "false"}
        aria-pressed={selected}
        className={`relative z-[2] flex w-full touch-manipulation flex-col gap-0.5 border-l-2 px-2 py-1.5 text-left pointer-events-auto ${
          selected
            ? "border-brand bg-brand/5"
            : "border-transparent hover:bg-slate-50"
        }`}
      >
        <span className="truncate text-[11px] font-semibold text-slate-800">
          {label}
        </span>
        {meta ? (
          <span className="truncate font-mono text-[9px] tabular-nums text-slate-400">
            {meta}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export default function AssetExplorer() {
  const selection = useWorkspaceStore((s) => s.selection);
  const selectAsset = useWorkspaceStore((s) => s.selectAsset);
  const setConfig = useWorkspaceStore((s) => s.setConfig);
  const pushConsole = useWorkspaceStore((s) => s.pushConsole);

  const [open, setOpen] = useState<Record<SectionId, boolean>>({
    drivers: true,
    vehicles: false,
    roadLaws: false,
    cycles: false,
    trips: true,
  });

  const drivers = listDrivers();
  const vehicles = listVehicles();
  const cycles = listSavedCycles();
  const trips = listSavedTrips();
  const [roadLaws, setRoadLaws] = useState<RoadLaw[]>(() => listRoadLawsSync());

  useEffect(() => {
    let cancelled = false;
    void listRoadLawsAsync().then((rows) => {
      if (!cancelled) setRoadLaws(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [selection.id, selection.kind]);

  const toggle = (id: SectionId) =>
    setOpen((o) => ({ ...o, [id]: !o[id] }));

  const pick = (kind: AssetKind, id: string, label: string) => {
    selectAsset(kind, id);
    pushConsole(`select ${kind} · ${label}`);
    if (kind === "driver") {
      const d = getDriver(id);
      // Must set driverId before scheduleUpdateDynamics — cheap IDM reads config.driverId.
      setConfig({
        driverId: id,
        ...(d ? { aY: d.a_y ?? 3.5 } : {}),
      });
      if (useWorkspaceStore.getState().geometry.corridor) {
        scheduleUpdateDynamics(75);
      }
    }
    if (kind === "vehicle") {
      if (useWorkspaceStore.getState().geometry.corridor) {
        pushConsole(
          "rebuild corridor · hint — vehicle selection not in cheap IDM; Rebuild corridor if needed"
        );
      }
    }
  };

  return (
    <div
      data-testid="ide-asset-explorer"
      className="flex h-full min-h-0 flex-col bg-white"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-2.5 py-2">
        <div>
          <div className="text-[12px] font-semibold text-slate-900">
            Bibliothèque
          </div>
          <div className="text-[10px] text-slate-400">
            Sélection → détail à droite
          </div>
        </div>
        <Link
          href="/?mode=library"
          className="text-[11px] font-semibold text-brand hover:underline"
        >
          Cycles
        </Link>
      </div>
      <div className="relative z-0 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <Section
          id="drivers"
          title="Conducteurs"
          open={open.drivers}
          onToggle={() => toggle("drivers")}
          count={drivers.length}
        >
          {drivers.map((d) => (
            <Row
              key={d.id}
              kind="driver"
              id={d.id}
              label={d.name}
              meta={`${d.baseProfile} · a=${d.physics.a_max.toFixed(2)}`}
              selected={selection.kind === "driver" && selection.id === d.id}
              onSelect={() => pick("driver", d.id, d.name)}
            />
          ))}
        </Section>
        <Section
          id="vehicles"
          title="Véhicules"
          open={open.vehicles}
          onToggle={() => toggle("vehicles")}
          count={vehicles.length}
        >
          {vehicles.map((v) => (
            <Row
              key={v.id}
              kind="vehicle"
              id={v.id}
              label={v.name}
              meta={`${Math.round(v.mass_kg)} kg · ${v.massCode}`}
              selected={selection.kind === "vehicle" && selection.id === v.id}
              onSelect={() => pick("vehicle", v.id, v.name)}
            />
          ))}
        </Section>
        <Section
          id="roadLaws"
          title="Lois de route"
          open={open.roadLaws}
          onToggle={() => toggle("roadLaws")}
          count={roadLaws.length}
        >
          {roadLaws.map((law) => (
            <Row
              key={law.id}
              kind="roadLaw"
              id={law.id}
              label={law.name}
              meta={`${law.region} · ${law.filter.mode}${
                law.vMaxCapKmh != null ? ` · ≤${law.vMaxCapKmh}` : ""
              }`}
              selected={
                selection.kind === "roadLaw" && selection.id === law.id
              }
              onSelect={() => pick("roadLaw", law.id, law.name)}
            />
          ))}
        </Section>
        <Section
          id="cycles"
          title="Cycles"
          open={open.cycles}
          onToggle={() => toggle("cycles")}
          count={cycles.length}
        >
          {cycles.slice(0, 80).map((c) => (
            <Row
              key={c.id}
              kind="cycle"
              id={c.id}
              label={c.name}
              meta={
                c.stats
                  ? `${(c.stats.distance_m / 1000).toFixed(1)} km · ${c.stats.v_mean_kmh?.toFixed?.(0) ?? "—"} km/h`
                  : c.source?.slice(0, 40)
              }
              selected={selection.kind === "cycle" && selection.id === c.id}
              onSelect={() => pick("cycle", c.id, c.name)}
            />
          ))}
        </Section>
        <Section
          id="trips"
          title="Trajets sauvés"
          open={open.trips}
          onToggle={() => toggle("trips")}
          count={trips.length}
        >
          {trips.length === 0 ? (
            <li
              data-testid="ide-empty-trips"
              className="px-2 py-2 font-mono text-[9px] leading-relaxed text-slate-500"
            >
              Aucun trajet sauvé. Créez un corridor via{" "}
              <span className="text-slate-700">/?mode=create</span>, puis
              enregistrez — la sélection ici charge la géométrie du trajet
              (pas de corridor inventé).
            </li>
          ) : (
            trips.map((t) => (
              <Row
                key={t.id}
                kind="trip"
                id={t.id}
                label={t.name || t.id}
                meta={t.savedAt?.slice?.(0, 19) ?? ""}
                selected={selection.kind === "trip" && selection.id === t.id}
                onSelect={() => pick("trip", t.id, t.name || t.id)}
              />
            ))
          )}
        </Section>
      </div>
      <div className="shrink-0 space-y-1.5 border-t border-slate-200 bg-slate-50 p-2">
        <Link
          href="/?mode=driver"
          className="block w-full rounded border border-slate-800 bg-slate-900 px-2 py-2 text-center text-[12px] font-semibold text-white hover:bg-slate-800"
        >
          Conducteur depuis traces
        </Link>
        <Link
          href="/?mode=create"
          className="block w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-center text-[11px] font-medium text-slate-700 hover:border-slate-500"
        >
          Créer un trajet GPS
        </Link>
        <Link
          href="/?mode=energy"
          className="block w-full rounded px-2 py-1 text-center text-[10px] text-slate-500 hover:text-slate-700"
        >
          Import énergie (t, v, pente)
        </Link>
      </div>
    </div>
  );
}
