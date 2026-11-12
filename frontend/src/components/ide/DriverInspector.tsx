"use client";

import { useEffect, useRef, useState } from "react";
import {
  completePhysics,
  type DriverPhysics,
} from "@/lib/driverPresets";
import { saveDriver, type SavedDriver } from "@/lib/driverLibrary";
import type { DriverProfile } from "@/lib/types";
import { scheduleUpdateDynamics } from "@/lib/ideSim";
import { useWorkspaceStore } from "@/lib/workspaceStore";

const REBUILD_HINT_AY =
  "rebuild corridor · hint — a_y affects corridor geometry (cheap IDM ignores a_y)";

const PROFILES: DriverProfile[] = [
  "Eco",
  "Normal",
  "Agressif",
  "Sportif",
  "Prudent",
  "Dynamique",
];

const FIELDS: Array<{ key: keyof DriverPhysics; label: string; step: number }> =
  [
    { key: "a_max", label: "a_max", step: 0.01 },
    { key: "b_comf", label: "b_comf", step: 0.01 },
    { key: "speed_factor", label: "sf", step: 0.01 },
    { key: "T", label: "T", step: 0.05 },
    { key: "T_h", label: "T_h", step: 0.1 },
    { key: "s0", label: "s0", step: 0.1 },
    { key: "jerk_max", label: "jerk+", step: 0.05 },
    { key: "jerk_brake_max", label: "jerk−", step: 0.05 },
    { key: "pedal_tau_s", label: "pedal_τ", step: 0.05 },
    { key: "vdes_tau_s", label: "vdes_τ", step: 0.05 },
    { key: "descent_hold_gain", label: "hold", step: 0.05 },
  ];

type Props = {
  driver: SavedDriver;
  onSaved?: (d: SavedDriver) => void;
};

export default function DriverInspector({ driver, onSaved }: Props) {
  const pushConsole = useWorkspaceStore((s) => s.pushConsole);
  const selectAsset = useWorkspaceStore((s) => s.selectAsset);
  const setConfig = useWorkspaceStore((s) => s.setConfig);
  const debounceSkipRef = useRef(true);
  const [name, setName] = useState(driver.name);
  const [baseProfile, setBaseProfile] = useState(driver.baseProfile);
  const [physics, setPhysics] = useState(() => completePhysics(driver.physics));
  const [aY, setAY] = useState(driver.a_y ?? 3.5);
  const [notes, setNotes] = useState(driver.notes ?? "");
  const [dirty, setDirty] = useState(false);
  const physicsTouchedRef = useRef(false);
  const aYTouchedRef = useRef(false);

  const prevDriverIdRef = useRef(driver.id);

  useEffect(() => {
    const idChanged = prevDriverIdRef.current !== driver.id;
    prevDriverIdRef.current = driver.id;
    // Ignore library stamp updates while the form is dirty (avoid clobbering
    // keystrokes between autosave and the next getDriver() read).
    if (!idChanged && dirty) return;

    setName(driver.name);
    setBaseProfile(driver.baseProfile);
    setPhysics(completePhysics(driver.physics));
    setAY(driver.a_y ?? 3.5);
    setNotes(driver.notes ?? "");
    setDirty(false);
    physicsTouchedRef.current = false;
    aYTouchedRef.current = false;
    debounceSkipRef.current = true;
    const nextAY = driver.a_y ?? 3.5;
    // Clear live overrides on select / library stamp so getDriver wins again.
    setConfig({
      aY: nextAY,
      driverId: driver.id,
      driverPhysicsOverride: null,
      driverProfileOverride: null,
    });
    // Sync only on identity / library stamp — not on object refs (physics),
    // which are re-created every getDriver()/readAll() and would loop forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [driver.id, driver.updatedAt, dirty, setConfig]);

  useEffect(() => {
    if (debounceSkipRef.current) {
      debounceSkipRef.current = false;
      return;
    }
    if (!dirty) return;

    const timer = setTimeout(() => {
      const completed = completePhysics(physics);
      // Seeds cannot autosave — still push live overrides for cheap IDM.
      setConfig({
        driverPhysicsOverride: completed,
        driverProfileOverride: baseProfile,
        aY,
        driverId: driver.id,
      });

      if (!driver.seed) {
        saveDriver({
          id: driver.id,
          name,
          baseProfile,
          physics: completed,
          a_y: aY,
          notes: notes || undefined,
          tags: driver.tags,
          sourceSha256: driver.sourceSha256,
        });
      }

      const corridor = useWorkspaceStore.getState().geometry.corridor;
      if (physicsTouchedRef.current && corridor) {
        scheduleUpdateDynamics(75);
      }
      if (aYTouchedRef.current) {
        pushConsole(REBUILD_HINT_AY);
      }
      physicsTouchedRef.current = false;
      aYTouchedRef.current = false;
    }, 75);

    return () => clearTimeout(timer);
  }, [
    physics,
    baseProfile,
    aY,
    dirty,
    driver.id,
    driver.seed,
    driver.tags,
    driver.sourceSha256,
    name,
    notes,
    pushConsole,
    setConfig,
  ]);

  const setField = (key: keyof DriverPhysics, raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setPhysics((p) => ({ ...p, [key]: n }));
    setDirty(true);
    physicsTouchedRef.current = true;
  };

  const onSave = () => {
    const saved = saveDriver({
      id: driver.seed ? undefined : driver.id,
      name: driver.seed ? `${name} (copie)` : name,
      baseProfile,
      physics: completePhysics(physics),
      a_y: aY,
      notes: notes || undefined,
      tags: driver.tags,
      sourceSha256: driver.sourceSha256,
    });
    selectAsset("driver", saved.id);
    setConfig({
      aY,
      driverId: saved.id,
      driverPhysicsOverride: null,
      driverProfileOverride: null,
    });
    pushConsole(
      `driver · saved ${saved.name}${driver.seed ? " (clone seed)" : ""}`
    );
    const corridor = useWorkspaceStore.getState().geometry.corridor;
    if (corridor && physicsTouchedRef.current) {
      scheduleUpdateDynamics(75);
    }
    if (aYTouchedRef.current) {
      pushConsole(REBUILD_HINT_AY);
    }
    setDirty(false);
    physicsTouchedRef.current = false;
    aYTouchedRef.current = false;
    debounceSkipRef.current = true;
    onSaved?.(saved);
  };

  return (
    <div className="space-y-2 p-2" data-testid="driver-inspector">
      <div className="border-b border-slate-200 pb-2">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          className="w-full border-b border-transparent bg-transparent text-[12px] font-semibold text-slate-900 outline-none focus:border-brand"
        />
        <div className="mt-0.5 font-mono text-[9px] text-slate-400">
          {driver.id}
          {driver.seed ? " · seed" : ""}
          {driver.sourceSha256
            ? ` · sha ${driver.sourceSha256.slice(0, 10)}…`
            : ""}
        </div>
      </div>

      <label className="flex items-center justify-between gap-2 font-mono text-[9px] uppercase text-slate-400">
        base
        <select
          value={baseProfile}
          onChange={(e) => {
            setBaseProfile(e.target.value as DriverProfile);
            setDirty(true);
            physicsTouchedRef.current = true;
          }}
          className="rounded border border-slate-200 bg-white px-1 py-0.5 font-mono text-[10px] text-slate-800"
        >
          {PROFILES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {FIELDS.map(({ key, label, step }) => (
          <label
            key={key}
            className="flex items-center justify-between gap-1 border-b border-slate-100 py-0.5"
          >
            <span className="font-mono text-[9px] uppercase text-slate-400">
              {label}
            </span>
            <input
              type="number"
              step={step}
              value={physics[key]}
              onChange={(e) => setField(key, e.target.value)}
              className="w-16 border-0 bg-transparent text-right font-mono text-[11px] tabular-nums text-slate-800 outline-none"
            />
          </label>
        ))}
        <label className="flex items-center justify-between gap-1 border-b border-slate-100 py-0.5">
          <span className="font-mono text-[9px] uppercase text-slate-400">
            a_y
          </span>
          <input
            type="number"
            step={0.05}
            value={aY}
            onChange={(e) => {
              setAY(Number(e.target.value));
              setDirty(true);
              aYTouchedRef.current = true;
            }}
            className="w-16 border-0 bg-transparent text-right font-mono text-[11px] tabular-nums text-slate-800 outline-none"
          />
        </label>
      </div>

      <textarea
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
          setDirty(true);
        }}
        rows={2}
        placeholder="notes"
        className="w-full resize-none rounded border border-slate-200 bg-slate-50 px-1.5 py-1 font-mono text-[9px] text-slate-600 outline-none focus:border-brand"
      />

      <button
        type="button"
        disabled={!dirty && !driver.seed}
        onClick={onSave}
        className="w-full rounded border border-slate-800 bg-slate-900 px-2 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-white enabled:hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {driver.seed ? "Sauver copie" : dirty ? "Sauver" : "À jour"}
      </button>
      <p className="font-mono text-[9px] leading-snug text-slate-400">
        IDM → Relancer dynamique. a_y latéral → Recalculer corridor.
      </p>
    </div>
  );
}
