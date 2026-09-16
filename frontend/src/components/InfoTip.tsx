"use client";

import { useId, useState } from "react";

type InfoTipProps = {
  title: string;
  children: React.ReactNode;
  /** Glyph inside the circle — default scientific "i", use "?" for format hints. */
  mark?: "i" | "?";
};

/** Compact tip control that reveals a definition / format popover. */
export default function InfoTip({ title, children, mark = "i" }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={mark === "?" ? `Format : ${title}` : `About ${title}`}
        aria-expanded={open}
        aria-controls={panelId}
        title={title}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onBlur={() => {
          // Delay so clicks inside panel can register
          window.setTimeout(() => setOpen(false), 120);
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-[9px] font-bold leading-none text-slate-500 hover:border-brand hover:text-brand"
      >
        {mark}
      </button>
      {open && (
        <div
          id={panelId}
          role="tooltip"
          className="absolute left-0 top-5 z-50 w-72 max-w-[min(18rem,calc(100vw-2rem))] rounded-md border border-slate-200 bg-white p-2.5 text-[11px] leading-relaxed text-slate-700 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            {title}
          </div>
          {children}
        </div>
      )}
    </span>
  );
}
