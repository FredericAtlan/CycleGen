"use client";

export type StudioWizardStep = 1 | 2 | 3 | 4;

export const STUDIO_WIZARD_LABELS: Record<StudioWizardStep, string> = {
  1: "Trajet",
  2: "Contraintes",
  3: "Comportement",
  4: "Résultats",
};

type StudioStepperProps = {
  activeStep: StudioWizardStep;
  maxUnlocked: StudioWizardStep;
  onStepChange: (step: StudioWizardStep) => void;
  /** Return to Studio home / mode picker (with confirm handled by parent). */
  onLeaveToMenu?: () => void;
  /** When set, only this step is selectable (ex. profil sans GPS → Résultats). */
  lockToStep?: StudioWizardStep;
  /** Cycle title in header (GPS A→B by default, saved name after save). */
  cycleTitle?: string | null;
};

export default function StudioStepper({
  activeStep,
  maxUnlocked,
  onStepChange,
  onLeaveToMenu,
  lockToStep,
  cycleTitle = null,
}: StudioStepperProps) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:gap-3">
      <button
        type="button"
        onClick={() => onLeaveToMenu?.()}
        className="shrink-0 text-[11px] font-semibold text-slate-500 hover:text-slate-800"
        title="Menu principal — recommencer"
      >
        ← Menu
      </button>
      {cycleTitle ? (
        <div
          className="hidden min-w-0 max-w-[40%] shrink truncate text-[11px] font-semibold tabular-nums text-slate-800 sm:block md:max-w-[46%]"
          title={cycleTitle}
        >
          {cycleTitle}
        </div>
      ) : null}
      <ol className="flex min-w-0 flex-1 items-center gap-1">
        {([1, 2, 3, 4] as const).map((n, i) => {
          const unlocked =
            lockToStep != null ? n === lockToStep : n <= maxUnlocked;
          const active = n === activeStep;
          return (
            <li key={n} className="flex min-w-0 flex-1 items-center gap-1">
              {i > 0 && <span className="h-px w-2 shrink-0 bg-slate-200 sm:w-4" />}
              <button
                type="button"
                disabled={!unlocked}
                onClick={() => unlocked && onStepChange(n)}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? "bg-slate-900 text-white"
                    : unlocked
                      ? "text-slate-700 hover:bg-slate-100"
                      : "text-slate-400"
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${
                    active
                      ? "bg-white text-slate-900"
                      : unlocked
                        ? "bg-brand/15 text-brand"
                        : "bg-slate-100"
                  }`}
                >
                  {n}
                </span>
                <span className="hidden truncate sm:inline">
                  {STUDIO_WIZARD_LABELS[n]}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {cycleTitle ? (
        <div
          className="min-w-0 max-w-[42%] truncate text-right text-[10px] font-semibold tabular-nums text-slate-700 sm:hidden"
          title={cycleTitle}
        >
          {cycleTitle}
        </div>
      ) : null}
    </div>
  );
}
