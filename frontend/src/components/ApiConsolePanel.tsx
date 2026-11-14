"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearApiActivity,
  getApiActivityBuffer,
  getApiInflight,
  subscribeApiActivity,
  subscribeApiInflight,
  type ApiActivityEntry,
  type ApiActivityLevel,
} from "@/lib/apiActivity";
import { apiOriginLabel, wsOriginLabel } from "@/lib/api";

/** Visible log rows when expanded (~4–5 lines). */
const EXPANDED_LOG_ROWS = 5;
const ROW_H_PX = 22;

const LEVEL_DOT: Record<ApiActivityLevel, string> = {
  info: "bg-slate-400",
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  error: "bg-rose-400",
  ws: "bg-sky-400",
};

const PROVIDER_STYLE: Record<string, string> = {
  HERE: "bg-amber-500/30 text-amber-100",
  Mapbox: "bg-sky-500/25 text-sky-100",
  OSRM: "bg-violet-500/25 text-violet-100",
  Overpass: "bg-lime-500/25 text-lime-100",
  "Open-Meteo": "bg-teal-500/25 text-teal-100",
  "Open-Elevation": "bg-teal-500/25 text-teal-100",
  OpenTopoData: "bg-teal-500/25 text-teal-100",
  Nominatim: "bg-orange-500/25 text-orange-100",
  CycleGen: "bg-slate-600/50 text-slate-100",
};

function providerClass(p?: string): string {
  if (!p) return "bg-slate-700 text-slate-300";
  return PROVIDER_STYLE[p] ?? "bg-slate-600/50 text-slate-100";
}

function formatTime(t: number): string {
  const d = new Date(t);
  return (
    [
      d.getHours().toString().padStart(2, "0"),
      d.getMinutes().toString().padStart(2, "0"),
      d.getSeconds().toString().padStart(2, "0"),
    ].join(":") + `.${d.getMilliseconds().toString().padStart(3, "0")}`
  );
}

/** One-line compact view (collapsed footer). */
function oneLine(e: ApiActivityEntry): string {
  const bits: string[] = [];
  if (e.provider) bits.push(`[${e.provider}]`);
  bits.push(e.label);
  if (e.method) bits.push(e.method);
  if (e.status != null) bits.push(String(e.status));
  if (e.durationMs != null) bits.push(`${e.durationMs}ms`);
  if (e.host) bits.push(e.host);
  if (e.bytesHint) bits.push(e.bytesHint);
  if (e.detail) bits.push(e.detail);
  return bits.join(" · ");
}

type ApiConsolePanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export default function ApiConsolePanel({
  open,
  onOpenChange,
}: ApiConsolePanelProps) {
  const [entries, setEntries] = useState<ApiActivityEntry[]>(() =>
    getApiActivityBuffer()
  );
  const [pending, setPending] = useState(() => getApiInflight());
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubLog = subscribeApiActivity((entry) => {
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > 500 ? next.slice(-500) : next;
      });
    });
    const unsubIn = subscribeApiInflight(setPending);
    return () => {
      unsubLog();
      unsubIn();
    };
  }, []);

  useEffect(() => {
    if (!open || !autoScroll) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, open, autoScroll, filter]);

  const last = entries[entries.length - 1];
  const live = pending > 0;
  const providers = Array.from(
    new Set(entries.map((e) => e.provider).filter(Boolean) as string[])
  );
  const visible =
    filter === "all"
      ? entries
      : entries.filter((e) => (e.provider || "CycleGen") === filter);

  const handleClear = useCallback(() => {
    clearApiActivity();
    setEntries(getApiActivityBuffer());
  }, []);

  const logHeight = EXPANDED_LOG_ROWS * ROW_H_PX;

  return (
    <footer
      className="pointer-events-auto z-[1300] flex w-full shrink-0 flex-col border-t border-slate-700 bg-slate-950 text-slate-200 shadow-[0_-4px_24px_rgba(0,0,0,0.35)]"
      aria-label="Console API"
    >
      {/* Toolbar — always full width */}
      <div className="flex h-8 w-full items-center gap-2 border-b border-slate-800/80 px-2 sm:px-3">
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left font-mono text-[11px] leading-none"
          title={open ? "Replier la console" : "Déplier la console (4–5 lignes)"}
          aria-expanded={open}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              live ? "animate-pulse bg-sky-400" : "bg-emerald-500"
            }`}
            aria-hidden
          />
          <span className="shrink-0 font-semibold uppercase tracking-wider text-slate-400">
            Console
          </span>
          <span className="shrink-0 text-slate-600" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          {!open ? (
            <>
              {last?.provider ? (
                <span
                  className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold ${providerClass(last.provider)}`}
                >
                  {last.provider}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-slate-300">
                {last ? oneLine(last) : `prêt · ${apiOriginLabel()}`}
              </span>
            </>
          ) : (
            <span className="hidden min-w-0 truncate text-[10px] text-slate-500 sm:inline">
              HTTP {apiOriginLabel()} · WS {wsOriginLabel()} ·{" "}
              {entries.length} événement
              {entries.length > 1 ? "s" : ""}
            </span>
          )}
          {live ? (
            <span className="shrink-0 rounded bg-sky-500/25 px-1.5 py-0.5 text-[9px] font-semibold text-sky-200">
              {pending} en cours
            </span>
          ) : null}
        </button>

        {open ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                filter === "all"
                  ? "bg-white/15 text-white"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              Tous
            </button>
            {(["HERE", "Mapbox", "OSRM", "Overpass", "CycleGen"] as const).map(
              (p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setFilter(p)}
                  className={`hidden rounded px-1.5 py-0.5 font-mono text-[9px] font-bold sm:inline ${
                    filter === p
                      ? providerClass(p)
                      : providers.includes(p)
                        ? "text-slate-400 hover:text-slate-200"
                        : "text-slate-600 hover:text-slate-400"
                  }`}
                >
                  {p}
                </button>
              )
            )}
            <label className="ml-1 flex cursor-pointer items-center gap-1 font-mono text-[9px] text-slate-500">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded border-slate-600"
              />
              auto
            </label>
            <button
              type="button"
              onClick={handleClear}
              className="rounded px-1.5 py-0.5 font-mono text-[10px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              Effacer
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded px-1.5 py-0.5 font-mono text-[10px] text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              aria-label="Replier"
            >
              −
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onOpenChange(true)}
            className="shrink-0 rounded border border-slate-700 px-2 py-0.5 font-mono text-[10px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
          >
            Déplier
          </button>
        )}
      </div>

      {/* Expanded: ~5 visible rows, scroll for history */}
      {open ? (
        <div
          ref={listRef}
          className="w-full overflow-y-auto overflow-x-hidden border-t border-slate-900 bg-slate-950 font-mono text-[10px] leading-[22px]"
          style={{ height: logHeight }}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          {visible.length === 0 ? (
            <p className="px-3 py-1 text-slate-500">
              Aucun événement — lance une analyse (HERE / Mapbox / OSRM) pour
              voir host, URL, statut, durée, taille…
            </p>
          ) : (
            <ul className="px-2 sm:px-3">
              {visible.map((e) => (
                <li
                  key={e.id}
                  className="flex h-[22px] items-center gap-1.5 overflow-hidden whitespace-nowrap border-b border-slate-900/60 hover:bg-slate-900/80"
                  title={[
                    e.label,
                    e.detail,
                    e.method,
                    e.host,
                    e.url,
                    e.status != null ? `status=${e.status}` : null,
                    e.durationMs != null ? `${e.durationMs} ms` : null,
                    e.bytesHint,
                  ]
                    .filter(Boolean)
                    .join("\n")}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_DOT[e.level]}`}
                    aria-hidden
                  />
                  <span className="w-[72px] shrink-0 tabular-nums text-slate-500">
                    {formatTime(e.t)}
                  </span>
                  <span
                    className={`w-16 shrink-0 truncate rounded px-1 text-center text-[9px] font-bold ${providerClass(e.provider)}`}
                  >
                    {e.provider || "—"}
                  </span>
                  {e.method ? (
                    <span className="w-10 shrink-0 text-slate-500">{e.method}</span>
                  ) : (
                    <span className="w-10 shrink-0" />
                  )}
                  <span className="min-w-0 shrink truncate font-medium text-slate-100">
                    {e.label}
                  </span>
                  {e.status != null ? (
                    <span className="shrink-0 text-slate-400">{e.status}</span>
                  ) : null}
                  {e.durationMs != null ? (
                    <span className="shrink-0 tabular-nums text-slate-500">
                      {e.durationMs}ms
                    </span>
                  ) : null}
                  {e.bytesHint ? (
                    <span className="shrink-0 text-slate-500">{e.bytesHint}</span>
                  ) : null}
                  {e.host ? (
                    <span className="hidden shrink-0 text-amber-200/90 md:inline">
                      {e.host}
                    </span>
                  ) : null}
                  {e.detail ? (
                    <span className="min-w-0 flex-1 truncate text-slate-400">
                      {e.detail}
                    </span>
                  ) : null}
                  {e.url ? (
                    <span className="hidden min-w-0 max-w-[40%] truncate text-slate-600 lg:inline">
                      {e.url}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </footer>
  );
}
