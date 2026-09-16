"use client";

/**
 * Bottom amber toasts (dismissible). Warnings bell lives in the header (WarningsBell).
 */

export type StudioToast = {
  id: string;
  message: string;
  /** Optional before→after detail lines under the title. */
  lines?: string[];
};

type StudioAlertsProps = {
  toasts: StudioToast[];
  onDismissToast: (id: string) => void;
};

export default function StudioAlerts({
  toasts,
  onDismissToast,
}: StudioAlertsProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-6 left-0 right-0 z-[1250] flex flex-col items-center gap-2 px-3">
      <div className="flex w-full max-w-lg flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto relative animate-fadeSlideUp rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 pr-5 text-[12px] font-medium leading-snug text-amber-950 shadow-lg"
          >
            <button
              type="button"
              onClick={() => onDismissToast(t.id)}
              className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded text-amber-800/80 hover:bg-amber-200/60 hover:text-amber-950"
              aria-label="Fermer le message"
              title="Fermer"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                aria-hidden
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
            <div className="px-3 pt-1 text-left">
              <p className="font-semibold text-amber-950">{t.message}</p>
              {(t.lines?.length ?? 0) > 0 ? (
                <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto border-t border-amber-300/70 pt-2 text-[11px] font-normal text-amber-950">
                  {t.lines!.map((line, i) => (
                    <li
                      key={`${i}-${line}`}
                      className="rounded bg-white/60 px-1.5 py-0.5 tabular-nums"
                    >
                      {line}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
