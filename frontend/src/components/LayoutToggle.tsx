"use client";

export type ViewLayout = "map" | "split" | "analysis";

type LayoutToggleProps = {
  layout: ViewLayout;
  onLayoutChange: (layout: ViewLayout) => void;
  compact?: boolean;
};

const MODES: {
  id: ViewLayout;
  label: string;
  title: string;
  icon: "map" | "split" | "chart";
}[] = [
  {
    id: "map",
    label: "Carte",
    title: "Plein écran carte (sidebar gauche gardée)",
    icon: "map",
  },
  {
    id: "split",
    label: "50/50",
    title: "Moitié carte · moitié analyse",
    icon: "split",
  },
  {
    id: "analysis",
    label: "Analyse",
    title: "Plein écran analyse (sidebar gauche gardée)",
    icon: "chart",
  },
];

function ModeIcon({ kind }: { kind: "map" | "split" | "chart" }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    "aria-hidden": true as const,
  };
  if (kind === "map") {
    return (
      <svg {...common}>
        <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" />
        <line x1="9" y1="3" x2="9" y2="18" />
        <line x1="15" y1="6" x2="15" y2="21" />
      </svg>
    );
  }
  if (kind === "split") {
    return (
      <svg {...common}>
        <rect x="3" y="4" width="8" height="16" rx="1" />
        <rect x="13" y="4" width="8" height="16" rx="1" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <polyline points="4 16 9 10 13 13 20 6" />
      <line x1="4" y1="20" x2="20" y2="20" />
    </svg>
  );
}

/** Three-way map / split / analysis layout (left sidebar always stays). */
export default function LayoutToggle({
  layout,
  onLayoutChange,
}: LayoutToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Disposition écran"
      className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 shadow-sm"
    >
      {MODES.map((m) => {
        const active = layout === m.id;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={m.title}
            aria-label={m.title}
            onClick={() => onLayoutChange(m.id)}
            className={`inline-flex h-7 w-7 items-center justify-center rounded transition active:scale-[0.96] ${
              active
                ? "bg-white text-brand shadow-sm ring-1 ring-slate-200"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            <ModeIcon kind={m.icon} />
          </button>
        );
      })}
    </div>
  );
}

/** Right analysis panel shell classes for each layout mode. */
export function analysisShellClass(layout: ViewLayout): string {
  const base =
    "flex h-full min-w-0 flex-col border-l border-slate-200 bg-white transition-[flex,width,opacity] duration-200";
  if (layout === "map") {
    return `${base} hidden w-0 overflow-hidden border-0 opacity-0`;
  }
  if (layout === "analysis") {
    return `${base} flex-1`;
  }
  return `${base} min-w-[280px] flex-1`;
}

/** Map column classes for each layout mode. */
export function mapShellClass(layout: ViewLayout): string {
  const base =
    "relative min-w-0 transition-[flex,width,opacity] duration-200";
  if (layout === "analysis") {
    return `${base} hidden w-0 overflow-hidden opacity-0`;
  }
  if (layout === "map") {
    return `${base} flex-1`;
  }
  return `${base} min-w-[200px] flex-1`;
}
