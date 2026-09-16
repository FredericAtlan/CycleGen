"use client";

/**
 * ChartFocusHost — unified 75vw sliding drawer for enlarging any chart.
 *
 * Usage:
 *   <ChartFocusHostProvider>
 *     ... your workspace ...
 *     <ChartFocusButton chartId="speed">Agrandir</ChartFocusButton>
 *     <ChartFocusSlot chartId="speed" title="Vitesses (f(s))">
 *       <SpeedLimitChart ... />
 *     </ChartFocusSlot>
 *   </ChartFocusHostProvider>
 *
 * The provider mounts a single portal ; ChartFocusSlot registers a renderer
 * that runs both inline and, when focused, inside the drawer.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type FocusRenderer = {
  title: string;
  subtitle?: string;
  render: () => ReactNode;
};

type ChartFocusCtx = {
  focus: string | null;
  setFocus: (id: string | null) => void;
  register: (id: string, renderer: FocusRenderer) => () => void;
};

const Ctx = createContext<ChartFocusCtx | null>(null);

export function useChartFocus(): ChartFocusCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("ChartFocusHostProvider missing in tree");
  return c;
}

export function ChartFocusHostProvider({ children }: { children: ReactNode }) {
  const [focus, setFocus] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const registry = useRef(new Map<string, FocusRenderer>());
  const [, forceTick] = useState(0);

  useEffect(() => {
    setMounted(true);
  }, []);

  const register = useCallback((id: string, renderer: FocusRenderer) => {
    registry.current.set(id, renderer);
    forceTick((n) => (n + 1) & 0xffff);
    return () => {
      registry.current.delete(id);
      forceTick((n) => (n + 1) & 0xffff);
    };
  }, []);

  const value = useMemo<ChartFocusCtx>(
    () => ({ focus, setFocus, register }),
    [focus, register]
  );

  useEffect(() => {
    if (focus == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  const renderer = focus != null ? registry.current.get(focus) : undefined;
  const drawer =
    mounted && focus != null && renderer
      ? createPortal(
          <div className="fixed inset-0 z-[1200] flex justify-end">
            <button
              type="button"
              aria-label="Fermer l’aperçu élargi"
              className="min-w-0 flex-1 bg-slate-900/35"
              onClick={() => setFocus(null)}
            />
            <aside
              className="relative flex h-full w-[75vw] min-w-[20rem] max-w-full flex-col border-l border-slate-200 bg-white shadow-2xl"
              style={{ animation: "cyclegen-focus-drawer-in 260ms ease-out" }}
              role="dialog"
              aria-modal="true"
              aria-label={renderer.title}
            >
              <style>{`
                @keyframes cyclegen-focus-drawer-in {
                  from { transform: translateX(100%); }
                  to { transform: translateX(0); }
                }
              `}</style>
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">
                    {renderer.title}
                  </p>
                  {renderer.subtitle && (
                    <p className="truncate text-[11px] text-slate-500">
                      {renderer.subtitle}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setFocus(null)}
                  className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Fermer (Esc)
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {renderer.render()}
              </div>
            </aside>
          </div>,
          document.body
        )
      : null;

  return (
    <Ctx.Provider value={value}>
      {children}
      {drawer}
    </Ctx.Provider>
  );
}

/**
 * Register a focusable renderer for a chart. The `children` still render inline
 * (compact); the same `render()` is called inside the drawer with `enlarged=true`
 * available via useIsEnlarged().
 */
export function ChartFocusSlot({
  chartId,
  title,
  subtitle,
  renderEnlarged,
  children,
}: {
  chartId: string;
  title: string;
  subtitle?: string;
  /** Full-size render when opened in the drawer. Falls back to `children`. */
  renderEnlarged?: () => ReactNode;
  children: ReactNode;
}) {
  const { register } = useChartFocus();
  const enlargedRef = useRef<(() => ReactNode) | null>(null);
  enlargedRef.current = renderEnlarged ?? (() => children);

  useEffect(() => {
    return register(chartId, {
      title,
      subtitle,
      render: () => enlargedRef.current?.() ?? null,
    });
  }, [chartId, title, subtitle, register]);

  return <>{children}</>;
}

/**
 * Button that opens (or closes) the drawer for the given chart id.
 */
export function ChartFocusButton({
  chartId,
  className,
  children = "Agrandir",
}: {
  chartId: string;
  className?: string;
  children?: ReactNode;
}) {
  const { focus, setFocus } = useChartFocus();
  const active = focus === chartId;
  return (
    <button
      type="button"
      onClick={() => setFocus(active ? null : chartId)}
      className={
        className ??
        "rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
      }
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
