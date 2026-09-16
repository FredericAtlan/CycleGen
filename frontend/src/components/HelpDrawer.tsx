"use client";

import { useEffect, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { useHelp } from "@/components/HelpContext";
import type { StudioWizardStep } from "@/components/StudioStepper";
import { STUDIO_WIZARD_LABELS } from "@/components/StudioStepper";
import {
  ARCHITECTURE_HELP,
  STEP_HELP_DOCS,
  stepHelpFor,
  stepHelpUrl,
  type HelpTab,
} from "@/lib/helpDocs";
import {
  SCIENCE_DOCS,
  scienceDocUrl,
  type ScienceDocMeta,
} from "@/lib/scienceDocs";

const SLOT_RE = /\uE000(\d+)\uE001/g;
const SLOT_ONLY_RE = /^\uE000\d+\uE001$/;

function slotToken(i: number): string {
  return `\uE000${i}\uE001`;
}

function katexHtml(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "html",
    });
  } catch {
    const esc = tex
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return displayMode
      ? `<pre class="math-fallback">${esc}</pre>`
      : `<code class="math-fallback">${esc}</code>`;
  }
}

/** Very small markdown → HTML (headings, lists, tables, code, bold, KaTeX). */
function renderMarkdown(md: string): string {
  const slots: string[] = [];
  const stash = (html: string) => {
    const i = slots.length;
    slots.push(html);
    return slotToken(i);
  };

  let text = md.replace(/\r\n/g, "\n");

  // Protect fenced code (no math inside)
  text = text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_m, _lang, body: string) => {
    const esc = String(body)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return stash(`<pre class="md-pre"><code>${esc}</code></pre>`);
  });

  // Display math: \[ ... \] and $$ ... $$
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_m, tex: string) =>
    stash(`<div class="math-block">${katexHtml(tex, true)}</div>`)
  );
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_m, tex: string) =>
    stash(`<div class="math-block">${katexHtml(tex, true)}</div>`)
  );

  // Inline math: \( ... \) and $ ... $
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_m, tex: string) =>
    stash(`<span class="math-inline">${katexHtml(tex, false)}</span>`)
  );
  text = text.replace(/\$([^$\n]+?)\$/g, (_m, tex: string) =>
    stash(`<span class="math-inline">${katexHtml(tex, false)}</span>`)
  );

  const lines = text.split("\n");
  const out: string[] = [];
  let inUl = false;
  let inTable = false;

  const closeUl = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push("</tbody></table>");
      inTable = false;
    }
  };

  const inline = (s: string) =>
    s
      .split(/(\uE000\d+\uE001)/g)
      .map((part) => {
        if (SLOT_ONLY_RE.test(part)) return part;
        return part
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(
            /\[([^\]]+)\]\(([^)]+)\)/g,
            '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
          );
      })
      .join("");

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();

    // Whole-line math / code slot — don't wrap in <p>
    if (SLOT_ONLY_RE.test(trimmed)) {
      closeUl();
      closeTable();
      out.push(trimmed);
      continue;
    }

    if (line.startsWith("|") && line.includes("|", 1)) {
      closeUl();
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) continue;
      if (!inTable) {
        inTable = true;
        out.push(
          '<table class="md-table"><thead><tr>' +
            cells.map((c) => `<th>${inline(c)}</th>`).join("") +
            "</tr></thead><tbody>"
        );
      } else {
        out.push(
          "<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>"
        );
      }
      continue;
    }
    closeTable();

    if (/^\s*[-*] /.test(line)) {
      if (!inUl) {
        inUl = true;
        out.push("<ul>");
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`);
      continue;
    }
    closeUl();

    if (line.startsWith("### ")) {
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (line.startsWith("## ")) {
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (line.startsWith("> ")) {
      out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    } else if (trimmed === "") {
      out.push("");
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeUl();
  closeTable();

  return out
    .join("\n")
    .replace(SLOT_RE, (_m, i: string) => slots[Number(i)] ?? "");
}

const TABS: { id: HelpTab; label: string }[] = [
  { id: "step", label: "Étape" },
  { id: "architecture", label: "Architecture" },
  { id: "science", label: "Science" },
];

export default function HelpDrawer() {
  const { open, closeHelp, tab, setTab, studioStep, setStudioStep } = useHelp();
  const [scienceId, setScienceId] = useState("readme");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHelp();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeHelp]);

  useEffect(() => {
    if (!open) return;
    let url: string | null = null;
    if (tab === "step") {
      url = stepHelpUrl(stepHelpFor(studioStep).file);
    } else if (tab === "architecture") {
      url = stepHelpUrl(ARCHITECTURE_HELP.file);
    } else {
      const meta: ScienceDocMeta | undefined = SCIENCE_DOCS.find(
        (d) => d.id === scienceId
      );
      if (meta) url = scienceDocUrl(meta.file);
    }
    if (!url) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setBody(renderMarkdown(text));
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Load failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, studioStep, scienceId]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-drawer-title"
    >
      <button
        type="button"
        aria-label="Fermer l’aide"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[1px]"
        onClick={closeHelp}
      />
      <aside className="relative z-[1] flex h-full w-[min(80vw,1100px)] max-w-full flex-col border-l border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2
              id="help-drawer-title"
              className="text-sm font-semibold text-slate-900"
            >
              Aide CycleGen
            </h2>
            <p className="truncate text-[11px] text-slate-500">
              {tab === "step"
                ? `Étape ${studioStep} · ${STUDIO_WIZARD_LABELS[studioStep]}`
                : tab === "architecture"
                  ? ARCHITECTURE_HELP.summary
                  : "Fiches scientifiques détaillées"}
            </p>
          </div>
          <button
            type="button"
            onClick={closeHelp}
            className="shrink-0 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            Fermer
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Sections d’aide"
          className="flex gap-1 border-b border-slate-100 bg-slate-50 px-3 py-2"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                tab === t.id
                  ? "bg-white text-brand shadow-sm ring-1 ring-slate-200"
                  : "text-slate-600 hover:bg-white/70"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1">
          {tab === "step" && (
            <nav className="w-36 shrink-0 overflow-y-auto border-r border-slate-100 bg-slate-50/80 p-2">
              {STEP_HELP_DOCS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setStudioStep(d.step as StudioWizardStep)}
                  className={`mb-0.5 w-full rounded-md px-2.5 py-2 text-left text-[11px] leading-snug ${
                    studioStep === d.step
                      ? "bg-white font-semibold text-brand shadow-sm ring-1 ring-slate-200"
                      : "text-slate-600 hover:bg-white/70"
                  }`}
                  title={d.summary}
                >
                  {d.step}. {STUDIO_WIZARD_LABELS[d.step]}
                </button>
              ))}
            </nav>
          )}
          {tab === "science" && (
            <nav className="w-44 shrink-0 overflow-y-auto border-r border-slate-100 bg-slate-50/80 p-2">
              {SCIENCE_DOCS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setScienceId(d.id)}
                  className={`mb-0.5 w-full rounded-md px-2.5 py-2 text-left text-[11px] leading-snug ${
                    scienceId === d.id
                      ? "bg-white font-semibold text-brand shadow-sm ring-1 ring-slate-200"
                      : "text-slate-600 hover:bg-white/70"
                  }`}
                  title={d.summary}
                >
                  {d.title}
                </button>
              ))}
            </nav>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto bg-white px-5 py-4">
            {loading && <p className="text-sm text-slate-600">Chargement…</p>}
            {error && <p className="text-sm text-red-600">Erreur : {error}</p>}
            {!loading && !error && (
              <div
                className="help-md"
                dangerouslySetInnerHTML={{ __html: body }}
              />
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
