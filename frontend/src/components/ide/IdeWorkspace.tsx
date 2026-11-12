"use client";

import { useEffect, useState } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";
import { getDriver, listDrivers } from "@/lib/driverLibrary";
import { listVehicles } from "@/lib/vehicleLibrary";
import { listRoadLawsAsync, listRoadLawsSync, type RoadLaw } from "@/lib/roadLawLibrary";
import { hydrateInitialWorkspace } from "@/lib/ideHydrate";
import {
  runRebuildCorridor,
  runUpdateDynamics,
  scheduleUpdateDynamics,
} from "@/lib/ideSim";
import { withBase } from "@/lib/basePath";
import { useWorkspaceStore } from "@/lib/workspaceStore";
import AssetExplorer from "./AssetExplorer";
import FitJobDrawer from "./FitJobDrawer";
import IdeCanvas from "./IdeCanvas";
import IdeConsole from "./IdeConsole";
import PropertyInspector from "./PropertyInspector";

/**
 * P3 IDE workspace — pickers + Update dynamics / Rebuild corridor.
 * Shell Créer remains on /?mode=create.
 */
export default function IdeWorkspace() {
  const storage =
    typeof window !== "undefined" ? window.localStorage : undefined;

  // react-resizable-panels v4: bare numbers = px. Always use "%" strings.
  // Drop collapsed layouts saved under bad px defaults (assets/inspector ~1%).
  if (typeof window !== "undefined") {
    try {
      for (const key of [
        "react-resizable-panels:cg-ide-main",
        "react-resizable-panels:cg-ide-center",
        "react-resizable-panels:cg-ide-main-v2",
        "react-resizable-panels:cg-ide-center-v2",
      ]) {
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        const layout = JSON.parse(raw) as Record<string, number>;
        const assets = layout.assets;
        const inspector = layout.inspector;
        const consoleH = layout.console;
        if (
          (typeof assets === "number" && assets < 10) ||
          (typeof inspector === "number" && inspector < 10) ||
          (typeof consoleH === "number" && consoleH < 8)
        ) {
          window.localStorage.removeItem(key);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const { defaultLayout: mainLayout, onLayoutChanged: onMainLayout } =
    useDefaultLayout({ id: "cg-ide-main-v2", storage });
  const { defaultLayout: centerLayout, onLayoutChanged: onCenterLayout } =
    useDefaultLayout({ id: "cg-ide-center-v2", storage });

  const [fitOpen, setFitOpen] = useState(false);
  const config = useWorkspaceStore((s) => s.config);
  const setConfig = useWorkspaceStore((s) => s.setConfig);
  const selectAsset = useWorkspaceStore((s) => s.selectAsset);
  const selection = useWorkspaceStore((s) => s.selection);
  const geometry = useWorkspaceStore((s) => s.geometry);
  const busyCheap = useWorkspaceStore((s) => s.busyCheap);
  const busyExpensive = useWorkspaceStore((s) => s.busyExpensive);
  const pushConsole = useWorkspaceStore((s) => s.pushConsole);

  const drivers = listDrivers();
  const vehicles = listVehicles();
  const [roadLaws, setRoadLaws] = useState<RoadLaw[]>(() => listRoadLawsSync());

  useEffect(() => {
    try {
      window.localStorage.removeItem("react-resizable-panels:cg-ide-main");
      window.localStorage.removeItem("react-resizable-panels:cg-ide-center");
    } catch {
      /* private mode */
    }
    hydrateInitialWorkspace();
    void listRoadLawsAsync().then(setRoadLaws);
    void (async () => {
      try {
        const { getRouteStudioPackSummary } = await import("@/lib/api");
        const pack = await getRouteStudioPackSummary();
        const s = pack.summary;
        if (s?.fidelity_mean != null) {
          pushConsole(
            `pack RS · fidelitȳ=${s.fidelity_mean} · RMSĒ=${s.rmse_mean ?? "—"} · n=${s.n_pairs ?? "—"}`
          );
        }
      } catch {
        /* offline OK */
      }
    })();
  }, [pushConsole]);

  const hasCorridor = !!(geometry.corridor && geometry.corridor.S?.length);
  const hasRoute = !!geometry.route;

  return (
    <div
      data-testid="ide-workspace"
      className="flex h-[calc(100dvh-3.25rem)] min-h-[28rem] w-full flex-col border-t border-slate-200 bg-slate-50"
    >
      {/* Identité trajet */}
      <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-slate-900">
            Banc d&apos;essai
          </div>
          <div className="truncate font-mono text-[10px] text-slate-500">
            {geometry.label ?? "Aucun trajet chargé"}
            {geometry.nPoints != null ? ` · ${geometry.nPoints} pts` : ""}
            {hasCorridor ? " · corridor OK" : hasRoute ? " · route sans corridor" : ""}
          </div>
        </div>
        {!hasCorridor && !hasRoute ? (
          <p
            data-testid="ide-no-corridor-cta"
            className="max-w-xs text-right text-[11px] leading-snug text-slate-600"
          >
            Chargez un{" "}
            <span className="font-semibold text-slate-800">trajet sauvé</span>{" "}
            (à gauche) ou{" "}
            <a
              href={withBase("/?mode=create")}
              className="font-semibold text-brand underline"
            >
              créez un trajet GPS
            </a>
            .
          </p>
        ) : null}
      </div>

      {/* Barre d'actions — 3 zones : contexte | outils | calcul */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-slate-50/80 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden font-mono text-[9px] font-bold uppercase tracking-wide text-slate-400 sm:inline">
            Contexte
          </span>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
            Conducteur
            <select
              data-testid="ide-picker-driver"
              value={config.driverId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                const d = id ? getDriver(id) : null;
                setConfig({
                  driverId: id,
                  ...(d ? { aY: d.a_y ?? 3.5 } : {}),
                });
                if (id) selectAsset("driver", id);
                if (hasCorridor) scheduleUpdateDynamics(75);
                else pushConsole("conducteur · défini (pas encore de corridor)");
              }}
              className="max-w-[10rem] rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px] text-slate-800"
            >
              <option value="">—</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
            Véhicule
            <select
              data-testid="ide-picker-vehicle"
              value={config.vehicleId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                setConfig({ vehicleId: id });
                if (id) selectAsset("vehicle", id);
                pushConsole(`véhicule · ${id ?? "—"}`);
              }}
              className="max-w-[10rem] rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px] text-slate-800"
            >
              <option value="">—</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
            Loi
            <select
              data-testid="ide-picker-roadlaw"
              value={config.roadLawId ?? ""}
              onChange={(e) => {
                const id = e.target.value || null;
                setConfig({ roadLawId: id });
                if (id) selectAsset("roadLaw", id);
                pushConsole(
                  `loi · ${id ?? "—"} (applique via Recalculer corridor)`
                );
              }}
              className="max-w-[9rem] rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px] text-slate-800"
            >
              <option value="">—</option>
              {roadLaws.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="hidden h-6 w-px bg-slate-200 sm:block" aria-hidden />

        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden font-mono text-[9px] font-bold uppercase tracking-wide text-slate-400 sm:inline">
            Outils
          </span>
          <a
            href="/?mode=driver"
            data-testid="ide-open-fingerprint"
            title="Studio Conducteur — choisir une trace puis identifier"
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:border-slate-500"
          >
            Conducteur depuis traces
          </a>
          <button
            type="button"
            onClick={() => setFitOpen(true)}
            data-testid="ide-open-fit"
            title="Ajuster le conducteur pour coller à une référence Route Studio"
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:border-slate-500"
          >
            Caler sur RS
          </button>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="hidden font-mono text-[9px] font-bold uppercase tracking-wide text-slate-400 sm:inline">
            Calcul
          </span>
          <button
            type="button"
            disabled={!hasRoute || busyCheap || busyExpensive}
            title={
              hasRoute
                ? "Recalcule géométrie + limites (coûteux, appel carto)"
                : "Pas de route — ouvrez un trajet sauvé ou créez un trajet GPS"
            }
            onClick={() => void runRebuildCorridor()}
            data-testid="ide-rebuild-corridor"
            data-enabled={
              hasRoute && !busyCheap && !busyExpensive ? "true" : "false"
            }
            className="rounded border border-amber-700/50 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-950 enabled:hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busyExpensive
              ? "Corridor…"
              : "Recalculer corridor"}
          </button>
          <button
            type="button"
            disabled={!hasCorridor || busyCheap || busyExpensive}
            title={
              hasCorridor
                ? "Rejoue le modèle conducteur (IDM) sur le corridor actuel — rapide"
                : "Besoin d’un corridor d’abord"
            }
            onClick={() => void runUpdateDynamics()}
            data-testid="ide-update-dynamics"
            data-enabled={
              hasCorridor && !busyCheap && !busyExpensive ? "true" : "false"
            }
            className="rounded border border-emerald-800/50 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-950 enabled:hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busyCheap ? "Dynamique…" : "Relancer dynamique"}
          </button>
        </div>

        <span
          data-testid="ide-selection-state"
          className="sr-only"
          aria-live="polite"
        >
          {`${selection.kind ?? "none"}:${selection.id ?? "—"};corridor=${hasCorridor};route=${hasRoute};driver=${config.driverId ?? "—"}`}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <Group
          orientation="horizontal"
          defaultLayout={mainLayout}
          onLayoutChanged={onMainLayout}
          className="h-full"
        >
          <Panel
            id="assets"
            defaultSize="18%"
            minSize="14%"
            maxSize="36%"
            className="relative z-[2] min-w-[12rem] overflow-hidden border-r border-slate-200 bg-white"
          >
            <AssetExplorer />
          </Panel>
          <Separator className="w-1.5 bg-slate-200 hover:bg-brand/40" />
          <Panel id="center" minSize="40%" className="min-w-0">
            <Group
              orientation="vertical"
              defaultLayout={centerLayout}
              onLayoutChanged={onCenterLayout}
              className="h-full"
            >
              <Panel id="canvas" defaultSize="78%" minSize="45%" className="min-h-0">
                <IdeCanvas />
              </Panel>
              <Separator className="h-1.5 bg-slate-200 hover:bg-brand/40" />
              <Panel
                id="console"
                defaultSize="22%"
                minSize="12%"
                maxSize="40%"
                className="min-h-0"
              >
                <IdeConsole />
              </Panel>
            </Group>
          </Panel>
          <Separator className="w-1.5 bg-slate-200 hover:bg-brand/40" />
          <Panel
            id="inspector"
            defaultSize="22%"
            minSize="16%"
            maxSize="36%"
            className="min-w-[14rem] border-l border-slate-200 bg-white"
          >
            <PropertyInspector />
          </Panel>
        </Group>
      </div>

      <FitJobDrawer open={fitOpen} onClose={() => setFitOpen(false)} />
    </div>
  );
}
