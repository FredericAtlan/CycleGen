"use client";

/**
 * Bibliothèque conducteurs + comparaison physique / profils source.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  deleteDriver,
  driverLabel,
  listDrivers,
  type SavedDriver,
} from "@/lib/driverLibrary";
import { DRIVER_PHYSICS_UI_KEYS } from "@/lib/driverIdentify";
import type { DriverPhysics } from "@/lib/driverPresets";

const COMPARE_COLORS = ["#0f766e", "#c2410c", "#1d4ed8", "#7c3aed", "#b45309"];

function PhysicsSpark({
  drivers,
}: {
  drivers: SavedDriver[];
}) {
  const rows = DRIVER_PHYSICS_UI_KEYS;
  return (
    <div className="overflow-x-auto rounded border border-slate-200 bg-white">
      <table className="w-full min-w-[28rem] border-collapse text-left text-[11px]">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400">
            <th className="px-2 py-1.5 font-semibold">Paramètre</th>
            {drivers.map((d, i) => (
              <th
                key={d.id}
                className="px-2 py-1.5 font-semibold"
                style={{ color: COMPARE_COLORS[i % COMPARE_COLORS.length] }}
              >
                {driverLabel(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-slate-100">
            <td className="px-2 py-1 text-slate-500">base</td>
            {drivers.map((d) => (
              <td key={d.id} className="px-2 py-1 font-mono tabular-nums">
                {d.baseProfile}
              </td>
            ))}
          </tr>
          <tr className="border-b border-slate-100">
            <td className="px-2 py-1 text-slate-500">a_y</td>
            {drivers.map((d) => (
              <td key={d.id} className="px-2 py-1 font-mono tabular-nums">
                {d.a_y != null ? d.a_y.toFixed(2) : "—"}
              </td>
            ))}
          </tr>
          {rows.map(({ key, label, unit, digits }) => (
            <tr key={key} className="border-b border-slate-100">
              <td className="px-2 py-1 text-slate-500">
                {label}
                {unit ? (
                  <span className="ml-1 text-slate-300">{unit}</span>
                ) : null}
              </td>
              {drivers.map((d) => {
                const v = d.physics[key as keyof DriverPhysics] ?? 0;
                return (
                  <td
                    key={d.id}
                    className="px-2 py-1 font-mono tabular-nums text-slate-800"
                  >
                    {Number(v).toFixed(digits ?? 2)}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="border-b border-slate-100">
            <td className="px-2 py-1 text-slate-500">profil source</td>
            {drivers.map((d) => (
              <td key={d.id} className="max-w-[9rem] truncate px-2 py-1 text-slate-600">
                {d.sourceProfile?.filename ?? "—"}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ProfileOverlay({ drivers }: { drivers: SavedDriver[] }) {
  const series = useMemo(() => {
    return drivers
      .map((d, i) => {
        const sp = d.sourceProfile;
        if (!sp?.time?.length || !sp.velocity_mps?.length) return null;
        const n = Math.min(sp.time.length, sp.velocity_mps.length);
        const t0 = sp.time[0];
        const tEnd = sp.time[n - 1] - t0 || 1;
        const pts = Array.from({ length: n }, (_, k) => ({
          x: (sp.time[k] - t0) / tEnd,
          y: sp.velocity_mps[k] * 3.6,
        }));
        const ymax = Math.max(...pts.map((p) => p.y), 1);
        return {
          id: d.id,
          name: driverLabel(d),
          color: COMPARE_COLORS[i % COMPARE_COLORS.length],
          pts,
          ymax,
          filename: sp.filename,
        };
      })
      .filter(Boolean) as Array<{
      id: string;
      name: string;
      color: string;
      pts: { x: number; y: number }[];
      ymax: number;
      filename: string;
    }>;
  }, [drivers]);

  if (!series.length) {
    return (
      <p className="rounded border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-[11px] text-slate-500">
        Aucun profil source enregistré pour la sélection — ré-identifiez et
        enregistrez pour conserver le v(t).
      </p>
    );
  }

  const w = 480;
  const h = 160;
  const pad = 8;
  const yMax = Math.max(...series.map((s) => s.ymax), 1);

  return (
    <div className="space-y-2 rounded border border-slate-200 bg-white p-2">
      <div className="flex flex-wrap gap-3 text-[10px] text-slate-500">
        {series.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: s.color }}
            />
            {s.name}
            <span className="truncate text-slate-400">· {s.filename}</span>
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-40 w-full"
        role="img"
        aria-label="Comparaison profils source v(t)"
      >
        <rect x={0} y={0} width={w} height={h} fill="#f8fafc" />
        {series.map((s) => {
          const d = s.pts
            .map((p, i) => {
              const x = pad + p.x * (w - 2 * pad);
              const y = h - pad - (p.y / yMax) * (h - 2 * pad);
              return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ");
          return (
            <path
              key={s.id}
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              opacity={0.9}
            />
          );
        })}
        <text x={pad} y={12} className="fill-slate-400" fontSize={9}>
          km/h (normalisé temps)
        </text>
      </svg>
    </div>
  );
}

type Props = {
  /** Bump to force re-read from localStorage after saves. */
  refreshKey?: number;
};

export default function DriverLibraryPanel({ refreshKey = 0 }: Props) {
  const [localBump, setLocalBump] = useState(0);
  // refreshKey / localBump intentionally bust listDrivers() via re-render
  void refreshKey;
  void localBump;
  const drivers = listDrivers();
  const users = drivers.filter((d) => !d.seed);
  const seeds = drivers.filter((d) => d.seed);
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<"all" | "user" | "seed">("user");

  const visible =
    tab === "user" ? users : tab === "seed" ? seeds : drivers;

  const compared = drivers.filter((d) => selected.includes(d.id)).slice(0, 5);

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 5) return [...prev.slice(1), id];
      return [...prev, id];
    });
  };

  const onDelete = (d: SavedDriver) => {
    if (d.seed) return;
    if (!window.confirm(`Supprimer « ${d.name} » ?`)) return;
    deleteDriver(d.id);
    setSelected((prev) => prev.filter((x) => x !== d.id));
    setLocalBump((n) => n + 1);
  };

  return (
    <section
      data-testid="driver-library-panel"
      className="space-y-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[13px] font-semibold text-slate-900">
            Bibliothèque conducteurs
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {users.length} enregistré(s) · {seeds.length} seed · cochez 2–5 pour
            comparer
          </p>
        </div>
        <div className="flex gap-1">
          {(
            [
              ["user", "Enregistrés"],
              ["seed", "Seeds"],
              ["all", "Tous"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`rounded px-2 py-1 text-[10px] font-semibold ${
                tab === k
                  ? "bg-slate-900 text-white"
                  : "border border-slate-200 bg-slate-50 text-slate-600"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <ul className="max-h-56 space-y-1 overflow-y-auto rounded border border-slate-100 bg-slate-50/50 p-1">
        {visible.length === 0 ? (
          <li className="px-2 py-3 text-[11px] text-slate-400">
            Aucun conducteur dans cet onglet.
          </li>
        ) : (
          visible.map((d) => {
            const on = selected.includes(d.id);
            return (
              <li
                key={d.id}
                data-testid={`driver-lib-row-${d.id}`}
                className={`flex items-center gap-2 rounded px-2 py-1.5 text-[11px] ${
                  on ? "bg-teal-50 ring-1 ring-teal-200" : "hover:bg-white"
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(d.id)}
                  className="accent-teal-700"
                  aria-label={`Comparer ${d.name}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-slate-800">
                    {driverLabel(d)}
                    {d.seed ? (
                      <span className="ml-1 text-[9px] font-normal text-slate-400">
                        seed
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate font-mono text-[9px] tabular-nums text-slate-400">
                    a={d.physics.a_max.toFixed(2)} · b=
                    {d.physics.b_comf.toFixed(2)} · τ=
                    {(d.physics.pedal_tau_s ?? 0).toFixed(2)}
                    {d.sourceProfile?.filename
                      ? ` · ${d.sourceProfile.filename}`
                      : ""}
                  </div>
                </div>
                <Link
                  href={`/?mode=create&driverId=${encodeURIComponent(d.id)}`}
                  className="shrink-0 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Créer
                </Link>
                {!d.seed ? (
                  <button
                    type="button"
                    onClick={() => onDelete(d)}
                    className="shrink-0 text-[10px] font-semibold text-red-600 hover:underline"
                  >
                    ×
                  </button>
                ) : null}
              </li>
            );
          })
        )}
      </ul>

      {compared.length >= 2 ? (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Comparaison ({compared.length})
          </h3>
          <PhysicsSpark drivers={compared} />
          <ProfileOverlay drivers={compared} />
        </div>
      ) : (
        <p className="text-[10px] text-slate-400">
          Sélectionnez au moins 2 conducteurs pour afficher le tableau et les
          profils source.
        </p>
      )}
    </section>
  );
}
