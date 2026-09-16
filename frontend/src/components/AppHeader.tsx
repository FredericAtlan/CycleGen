"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import CycleGenLogo from "@/components/CycleGenLogo";
import { useHelpOptional } from "@/components/HelpContext";
import WarningsBell from "@/components/WarningsBell";
import {
  useHeaderChromeOptional,
  type StudioHeaderChrome,
  type VersusHeaderChrome,
} from "@/components/HeaderChromeContext";
import { STUDIO_WIZARD_LABELS } from "@/components/StudioStepper";
import { APP_AUTHOR, APP_NAME, APP_VERSION } from "@/lib/branding";
import { hasStudioSession } from "@/lib/studioSession";

function StudioSteps({ chrome }: { chrome: StudioHeaderChrome }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      {chrome.cycleTitle ? (
        <div
          className="hidden min-w-0 max-w-[9rem] shrink truncate text-[10px] font-semibold tabular-nums text-slate-600 lg:block xl:max-w-[14rem]"
          title={chrome.cycleTitle}
        >
          {chrome.cycleTitle}
        </div>
      ) : null}
      <ol className="flex min-w-0 flex-1 items-center gap-0.5">
        {([1, 2, 3, 4] as const).map((n, i) => {
          const unlocked =
            chrome.lockToStep != null
              ? n === chrome.lockToStep
              : n <= chrome.maxUnlocked;
          const active = n === chrome.activeStep;
          return (
            <li key={n} className="flex min-w-0 flex-1 items-center gap-0.5">
              {i > 0 && (
                <span className="hidden h-px w-2 shrink-0 bg-slate-200 sm:block" />
              )}
              <button
                type="button"
                disabled={!unlocked}
                onClick={() => unlocked && chrome.onStepChange(n)}
                className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:justify-start sm:px-2 sm:text-[11px] ${
                  active
                    ? "bg-slate-900 text-white"
                    : unlocked
                      ? "text-slate-700 hover:bg-slate-100"
                      : "text-slate-400"
                }`}
                title={STUDIO_WIZARD_LABELS[n]}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] ${
                    active
                      ? "bg-white text-slate-900"
                      : unlocked
                        ? "bg-brand/15 text-brand"
                        : "bg-slate-100"
                  }`}
                >
                  {n}
                </span>
                <span className="hidden truncate md:inline">
                  {STUDIO_WIZARD_LABELS[n]}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function VersusControls({ chrome }: { chrome: VersusHeaderChrome }) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:gap-2">
      <span className="mr-auto hidden truncate text-[10px] font-semibold uppercase tracking-wide text-slate-400 lg:inline">
        Comparaison des cycles
      </span>
      <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
        {(
          [
            ["time", "Temps"],
            ["distance", "Distance"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => chrome.onXMode(id)}
            className={`rounded px-2 py-1 text-[10px] font-semibold ${
              chrome.xMode === id
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={!chrome.canExplore}
        onClick={chrome.onExplorer}
        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 sm:px-2.5"
        title="Explorer les courbes (layout, curseurs, export)"
      >
        Explorer
      </button>
      <button
        type="button"
        disabled={chrome.jpegBusy || !chrome.canExplore}
        onClick={chrome.onJpeg}
        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 sm:px-2.5"
        title="Exporter les graphes en JPEG"
      >
        {chrome.jpegBusy ? "…" : "JPEG"}
      </button>
      <button
        type="button"
        onClick={chrome.onAddCycle}
        className="inline-flex items-center gap-0.5 rounded-md bg-brand px-2 py-1 text-[10px] font-semibold text-white hover:bg-brand-dark sm:px-2.5"
      >
        <span className="text-sm leading-none">+</span> Cycle
      </button>
    </div>
  );
}

export default function AppHeader() {
  const pathname = usePathname();
  const help = useHelpOptional();
  const headerChrome = useHeaderChromeOptional();
  const chrome = headerChrome?.chrome ?? null;
  const [mounted, setMounted] = useState(false);
  const [resumeStudio, setResumeStudio] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    setResumeStudio(hasStudioSession());
  }, [mounted, pathname]);

  useEffect(() => {
    if (!help) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (help.open) help.closeHelp();
      else help.openHelp();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [help]);

  const versus = mounted && (pathname?.startsWith("/compare") ?? false);
  const studio = mounted && !versus;

  const linkClass = (active: boolean) =>
    `rounded-md px-2.5 py-1.5 text-xs font-semibold sm:px-3 ${
      active
        ? "bg-slate-900 text-white"
        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    }`;

  const studioHref = resumeStudio ? "/?mode=create" : "/";
  const showMenu = chrome?.kind === "studio";

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-2 sm:gap-3 sm:px-3">
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand text-white sm:h-8 sm:w-8">
          <CycleGenLogo className="h-5 w-5 sm:h-6 sm:w-6" />
        </div>
        <div className="hidden min-w-0 leading-tight sm:block">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-sm font-bold tracking-wide text-slate-900">
              {APP_NAME}
            </span>
            <span className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[9px] font-semibold tabular-nums text-slate-600">
              v{APP_VERSION}
            </span>
          </div>
          <div className="truncate text-[10px] text-slate-500">{APP_AUTHOR}</div>
        </div>
      </div>

      <nav className="flex shrink-0 items-center gap-0.5" aria-label="Principal">
        {showMenu && chrome.kind === "studio" && (
          <button
            type="button"
            onClick={chrome.onLeaveToMenu}
            className="rounded-md px-2 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 sm:px-2.5"
            title="Menu principal — quitter le studio"
          >
            Menu
          </button>
        )}
        {versus && (
          <Link
            href="/"
            className="rounded-md px-2 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 sm:px-2.5"
            title="Menu principal — choix du mode"
          >
            Menu
          </Link>
        )}
        <Link
          href={studioHref}
          className={linkClass(studio)}
          title={
            resumeStudio
              ? "Reprendre la session Studio en cours"
              : "Studio"
          }
        >
          Studio
        </Link>
        <Link href="/compare" className={linkClass(versus)}>
          Versus
        </Link>
      </nav>

      {chrome?.kind === "studio" && <StudioSteps chrome={chrome} />}
      {chrome?.kind === "versus" && <VersusControls chrome={chrome} />}

      <div
        className={`flex shrink-0 items-center gap-1 ${chrome ? "" : "ml-auto"}`}
      >
        <WarningsBell />
        {help && (
          <button
            type="button"
            onClick={() =>
              help.open
                ? help.closeHelp()
                : help.openHelp({
                    tab: versus ? "architecture" : "step",
                  })
            }
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md border text-sm font-bold transition ${
              help.open
                ? "border-brand bg-brand/10 text-brand"
                : "border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            }`}
            title="Aide (raccourci ?)"
            aria-label="Ouvrir l’aide"
            aria-pressed={help.open}
          >
            ?
          </button>
        )}
      </div>
    </header>
  );
}
