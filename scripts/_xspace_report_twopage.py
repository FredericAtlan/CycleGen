"""Post-process CycleGen AVL XSPACE HTML report into 2 in-file pages."""

from __future__ import annotations

import re
from pathlib import Path

_CSS_NAV = """
  .page-nav {
    position: sticky;
    top: 0;
    z-index: 40;
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: center;
    padding: 0.65rem 1.5rem;
    background: rgba(15,20,25,0.92);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--line);
  }
  .page-nav .brand {
    font-size: 0.78rem;
    color: var(--muted);
    margin-right: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .page-nav button {
    appearance: none;
    border: 1px solid var(--line);
    background: rgba(0,0,0,0.28);
    color: var(--muted);
    padding: 0.45rem 0.95rem;
    border-radius: 999px;
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 600;
  }
  .page-nav button.active {
    color: var(--ink);
    border-color: rgba(61,184,160,0.65);
    background: rgba(61,184,160,0.18);
  }
  .page-nav .page-nav-hint {
    margin-left: auto;
    font-size: 0.7rem;
    color: var(--muted);
  }
  main .page {
    display: none;
    grid-column: 1 / -1;
  }
  main .page.active {
    display: grid;
    gap: 1.25rem;
  }
"""

_NAV = """
<nav class="page-nav" role="tablist" aria-label="Pages du rapport">
  <span class="brand">CycleGen × AVL Route Studio</span>
  <button type="button" class="active" data-page="graphiques" role="tab" aria-selected="true">1 · Analyse graphique</button>
  <button type="button" data-page="analyse" role="tab" aria-selected="false">2 · Analyse textuelle &amp; recommandations</button>
  <span class="page-nav-hint">Fichier unique · 2 pages · prêt à envoyer</span>
</nav>
"""

_INTRO_A = """  <section class="panel">
    <h2>Page Analyse — mode d’emploi</h2>
    <p class="hint" style="margin:0;font-size:0.85rem;color:#c8d4e0;line-height:1.5">
      Cette page regroupe la synthèse KPI, la lecture expert (véhicule &amp; conducteur),
      les écarts de forme vs agrégats, et le tableau des meilleurs bras.
      Passez à <strong>Graphiques</strong> pour les radar / barres / profils interactifs
      (zoom, sync X). Un seul fichier HTML autonome — partageable par e-mail.
    </p>
  </section>
"""

_INTRO_G = """  <section class="panel">
    <h2>Page Graphiques — mode d’emploi</h2>
    <p class="hint" style="margin:0;font-size:0.85rem;color:#c8d4e0;line-height:1.5">
      Radar d’empreintes, RMSE par preset, puis profils v(s) / Δv / accélération /
      altitude / pente. Zoomez un graphe puis <strong>Synchroniser la plage</strong>
      pour aligner tous les axes distance (Y adapté automatiquement).
    </p>
  </section>
"""

_PAGE_JS = """
function showPage(pageId) {
  document.querySelectorAll("main .page").forEach((p) => {
    p.classList.toggle("active", p.dataset.page === pageId);
  });
  document.querySelectorAll(".page-nav button[data-page]").forEach((b) => {
    const on = b.dataset.page === pageId;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (pageId === "graphiques") {
    requestAnimationFrame(() => {
      const ids = ["chart-radar", "chart-rmse"].concat(
        typeof PROFILE_CHART_IDS !== "undefined" ? PROFILE_CHART_IDS : []
      );
      ids.forEach((id) => {
        const gd = document.getElementById(id);
        if (gd && gd.data) {
          try { Plotly.Plots.resize(gd); } catch (e) {}
        }
      });
    });
  }
  try { history.replaceState(null, "", "#" + pageId); } catch (e) {}
}
document.querySelectorAll(".page-nav button[data-page]").forEach((b) => {
  b.onclick = () => showPage(b.dataset.page);
});
const hash = (location.hash || "").replace("#", "");
if (hash === "graphiques" || hash === "analyse") showPage(hash);
else showPage("graphiques");
"""

_ANALYSIS_TITLES = {
    "Synthèse KPI",
    "Lecture expert — modèle véhicule",
    "Lecture expert — comportement conducteur",
    "Écarts de forme de courbe vs valeurs agrégées",
    "Page Analyse — mode d’emploi",
}


def apply_two_page_layout(html: str) -> str:
    text = html
    if ".page-nav {" not in text:
        text = text.replace("  footer {", _CSS_NAV + "\n  footer {", 1)

    if 'id="page-analyse"' not in text:
        main_m = re.search(r"<main>(.*?)</main>", text, re.S)
        if not main_m:
            return text
        sections = re.findall(r"<section[\s\S]*?</section>", main_m.group(1))
        analysis_secs: list[str] = []
        graphics_secs: list[str] = []
        for s in sections:
            hm = re.search(r"<h2>([^<]+)</h2>", s)
            if not hm:
                continue
            h = hm.group(1)
            if h in _ANALYSIS_TITLES or h.startswith("Page Analyse"):
                analysis_secs.append(s)
            elif h == "Tableau de bord — meilleur bras par trace":
                table_m = re.search(
                    r'(<table class="score">.*?</table>)', s, re.S
                )
                chart_m = re.search(r'(<div id="chart-rmse".*?</div>)', s, re.S)
                if table_m:
                    analysis_secs.append(
                        '<section class="panel">\n'
                        "    <h2>Tableau de bord — meilleur bras par trace</h2>\n"
                        '    <p class="hint">RMSE_v et ΔT du meilleur preset '
                        "CycleGen vs chaque trace AVL.</p>\n"
                        f"    {table_m.group(1)}\n"
                        "  </section>"
                    )
                if chart_m:
                    graphics_secs.append(
                        '<section class="panel">\n'
                        "    <h2>RMSE par preset (barres)</h2>\n"
                        '    <p class="hint">Erreur de vitesse (km/h) par bras '
                        "Eco / Normal / Sportif / Std AVL.</p>\n"
                        f"    {chart_m.group(1)}\n"
                        "  </section>"
                    )
            elif (
                h.startswith("Empreintes")
                or h.startswith("Profils")
                or h.startswith("RMSE")
                or h.startswith("Page Graphiques")
            ):
                graphics_secs.append(s)
            else:
                analysis_secs.append(s)

        new_main = (
            "<main>\n"
            '  <div class="page active" id="page-graphiques" data-page="graphiques">\n'
            + _INTRO_G
            + "\n".join(graphics_secs)
            + "\n  </div>\n"
            '  <div class="page" id="page-analyse" data-page="analyse">\n'
            + _INTRO_A
            + "\n".join(analysis_secs)
            + "\n  </div>\n"
            "</main>"
        )
        text = text[: main_m.start()] + new_main + text[main_m.end() :]

    if 'class="page-nav"' not in text:
        text = text.replace("<body>\n", "<body>\n" + _NAV, 1)

    text = text.replace(
        """<footer>
  Rapport généré par <code>scripts/report_xspace_avl_html.py</code> —
  données embarquées, aucune API requise. Plotly 2.35 (CDN).
</footer>""",
        """<footer>
  Rapport CycleGen × AVL XSPACE — 2 pages (Analyse / Graphiques) dans un seul HTML.
  Généré par <code>scripts/report_xspace_avl_html.py</code> · données embarquées · Plotly 2.35 (CDN).
  Emplacement projet : <code>docs/reports/xspace_avl_calibration_report.html</code>
</footer>""",
        1,
    )

    if "function showPage(pageId)" not in text:
        boot_old = (
            'document.getElementById("btn-sync-x").onclick = () => syncDistanceWindow();\n'
            'document.getElementById("btn-reset-zoom").onclick = () => resetAllProfileZoom();\n'
        )
        if boot_old in text:
            text = text.replace(boot_old, boot_old + _PAGE_JS, 1)

    # Hint on profiles page
    text = text.replace(
        "Zoom : clic-glisser (X et Y) · double-clic = reset · pan via la barre Plotly.\n"
        "      Bouton « Synchroniser » : même plage distance sur tous les graphes, Y adapté à la fenêtre.\n"
        "      Δv = CycleGen − AVL (km/h) sur l’axe distance.",
        "Navigation haut de page : Analyse ↔ Graphiques (même fichier).\n"
        "      Zoom : clic-glisser (X et Y) · Synchroniser = même plage distance, Y adapté.\n"
        "      Δv = CycleGen − AVL (km/h) sur l’axe distance.",
        1,
    )
    return text


def publish_report(html_path: Path, repo_root: Path | None = None) -> Path:
    """Apply 2-page layout, overwrite html_path, copy to docs/reports/."""
    html_path = Path(html_path)
    text = apply_two_page_layout(html_path.read_text(encoding="utf-8"))
    html_path.write_text(text, encoding="utf-8")
    if repo_root is None:
        # .../backend/app/data/benchmark/calibration/file.html → repo root
        repo_root = html_path.resolve().parents[5]
    docs_dir = Path(repo_root) / "docs" / "reports"
    docs_dir.mkdir(parents=True, exist_ok=True)
    dest = docs_dir / "xspace_avl_calibration_report.html"
    dest.write_text(text, encoding="utf-8")
    readme = docs_dir / "README.md"
    line = (
        "- [`xspace_avl_calibration_report.html`](./xspace_avl_calibration_report.html) "
        "— calibration AVL Route Studio XSPACE (2 pages : Analyse / Graphiques). "
        "Fichier autonome à envoyer par e-mail.\n"
    )
    if not readme.exists():
        readme.write_text("# Rapports CycleGen\n\n" + line, encoding="utf-8")
    elif "xspace_avl_calibration_report" not in readme.read_text(encoding="utf-8"):
        readme.write_text(
            readme.read_text(encoding="utf-8").rstrip() + "\n\n" + line,
            encoding="utf-8",
        )
    return dest


if __name__ == "__main__":
    latest = (
        Path(__file__).resolve().parents[1]
        / "backend/app/data/benchmark/calibration/xspace_avl_report_latest.html"
    )
    out = publish_report(latest)
    print(out)
