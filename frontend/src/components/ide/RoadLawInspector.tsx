"use client";

import { useEffect, useState } from "react";
import {
  LEGAL_SMOOTH_MODES,
  type LegalSmoothMode,
} from "@/lib/legalFilter";
import {
  getRoadLawAsync,
  getRoadLawSync,
  saveRoadLawAsync,
  type RoadLaw,
} from "@/lib/roadLawLibrary";
import { useWorkspaceStore } from "@/lib/workspaceStore";

type Props = {
  lawId: string;
};

export default function RoadLawInspector({ lawId }: Props) {
  const pushConsole = useWorkspaceStore((s) => s.pushConsole);
  const setConfig = useWorkspaceStore((s) => s.setConfig);
  const [law, setLaw] = useState<RoadLaw | null>(
    () => getRoadLawSync(lawId)
  );
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getRoadLawAsync(lawId).then((row) => {
      if (!cancelled) {
        setLaw(row);
        setDirty(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lawId]);

  if (!law) {
    return (
      <p className="p-3 font-mono text-[10px] text-red-600">Loi introuvable</p>
    );
  }

  const setFilter = (patch: Partial<RoadLaw["filter"]>) => {
    setLaw((L) =>
      L ? { ...L, filter: { ...L.filter, ...patch } } : L
    );
    setDirty(true);
  };

  const onSave = async () => {
    if (!law) return;
    const id = law.seed ? `law-${Date.now().toString(36)}` : law.id;
    const saved = await saveRoadLawAsync({
      ...law,
      id,
      name: law.seed ? `${law.name} (copie)` : law.name,
      seed: false,
    });
    setConfig({ roadLawId: saved.id });
    pushConsole(`roadLaw · saved ${saved.name}`);
    setLaw(saved);
    setDirty(false);
  };

  const apply = () => {
    setConfig({ roadLawId: law.id });
    pushConsole(
      `roadLaw · apply ${law.name} — Rebuild corridor pour prendre effet`
    );
  };

  return (
    <div className="space-y-2 p-2" data-testid="roadlaw-inspector">
      <div className="border-b border-slate-200 pb-2">
        <input
          value={law.name}
          onChange={(e) => {
            setLaw({ ...law, name: e.target.value });
            setDirty(true);
          }}
          className="w-full border-b border-transparent bg-transparent text-[12px] font-semibold outline-none focus:border-brand"
        />
        <div className="font-mono text-[9px] text-slate-400">
          {law.id} · {law.region}
          {law.seed ? " · seed" : ""}
        </div>
      </div>

      <label className="flex items-center justify-between font-mono text-[9px] uppercase text-slate-400">
        mode
        <select
          value={law.filter.mode}
          onChange={(e) =>
            setFilter({ mode: e.target.value as LegalSmoothMode })
          }
          className="rounded border border-slate-200 px-1 py-0.5 font-mono text-[10px]"
        >
          {LEGAL_SMOOTH_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center justify-between border-b border-slate-100 py-0.5 font-mono text-[9px] uppercase text-slate-400">
        windowM
        <input
          type="number"
          value={law.filter.windowM}
          onChange={(e) => setFilter({ windowM: Number(e.target.value) })}
          className="w-16 text-right font-mono text-[11px] tabular-nums outline-none"
        />
      </label>
      <label className="flex items-center justify-between border-b border-slate-100 py-0.5 font-mono text-[9px] uppercase text-slate-400">
        minRunM
        <input
          type="number"
          value={law.filter.minRunM}
          onChange={(e) => setFilter({ minRunM: Number(e.target.value) })}
          className="w-16 text-right font-mono text-[11px] tabular-nums outline-none"
        />
      </label>
      <label className="flex items-center justify-between border-b border-slate-100 py-0.5 font-mono text-[9px] uppercase text-slate-400">
        vMaxCap
        <input
          type="number"
          value={law.vMaxCapKmh ?? ""}
          placeholder="—"
          onChange={(e) => {
            const n = Number(e.target.value);
            setLaw({
              ...law,
              vMaxCapKmh: Number.isFinite(n) && e.target.value !== "" ? n : null,
            });
            setDirty(true);
          }}
          className="w-16 text-right font-mono text-[11px] tabular-nums outline-none"
        />
      </label>

      {law.notes ? (
        <p className="font-mono text-[9px] leading-snug text-slate-500">
          {law.notes}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={apply}
          className="flex-1 rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-[10px] font-semibold uppercase text-slate-700 hover:border-slate-500"
        >
          Appliquer
        </button>
        <button
          type="button"
          disabled={!dirty && !law.seed}
          onClick={() => void onSave()}
          className="flex-1 rounded bg-slate-900 px-2 py-1.5 font-mono text-[10px] font-semibold uppercase text-white disabled:opacity-40"
        >
          {law.seed ? "Copie" : dirty ? "Sauver" : "À jour"}
        </button>
      </div>
    </div>
  );
}
