#!/usr/bin/env python3
"""Inject fresh XSPACE payload into the polished HTML shell + refresh reco."""

from __future__ import annotations

import json
import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_CALIB = _ROOT / "backend/app/data/benchmark/calibration"
_DOCS = _ROOT / "docs/reports"
_SHELL = _ROOT / "scripts/templates_xspace_avl_report_shell.html"


def extract_payload(html: str) -> dict:
    m = re.search(
        r'<script id="payload" type="application/json">(.*?)</script>',
        html,
        re.S,
    )
    if not m:
        raise RuntimeError("payload script not found")
    return json.loads(m.group(1).replace("<\\/", "</"))


def embed_payload(html: str, payload: dict) -> str:
    raw = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    return re.sub(
        r'<script id="payload" type="application/json">.*?</script>',
        f'<script id="payload" type="application/json">{raw}</script>',
        html,
        count=1,
        flags=re.S,
    )


def patch_js_presets(html: str) -> str:
    """Ensure Prudent/Dynamique exist in chart JS constants."""
    html = re.sub(
        r'const PRESETS = \[[^\]]+\];',
        'const PRESETS = ["Eco","Normal","Sportif","Standard_AVL_BCB","Prudent","Dynamique"];',
        html,
        count=1,
    )
    # PRESET_LABEL short
    html = re.sub(
        r"const PRESET_LABEL = \{.*?\n\};",
        """const PRESET_LABEL = {
  Eco: "CG Eco",
  Normal: "CG Normal",
  Sportif: "CG Sportif",
  Standard_AVL_BCB: "CG Std BCB",
  Prudent: "CG Prudent",
  Dynamique: "CG Dynamique",
};""",
        html,
        count=1,
        flags=re.S,
    )
    if "PRESET_LABEL_FULL" not in html:
        html = html.replace(
            """const PRESET_LABEL = {
  Eco: "CG Eco",
  Normal: "CG Normal",
  Sportif: "CG Sportif",
  Standard_AVL_BCB: "CG Std BCB",
  Prudent: "CG Prudent",
  Dynamique: "CG Dynamique",
};""",
            """const PRESET_LABEL = {
  Eco: "CG Eco",
  Normal: "CG Normal",
  Sportif: "CG Sportif",
  Standard_AVL_BCB: "CG Std BCB",
  Prudent: "CG Prudent",
  Dynamique: "CG Dynamique",
};
const PRESET_LABEL_FULL = {
  Eco: "CycleGen · Eco",
  Normal: "CycleGen · Normal",
  Sportif: "CycleGen · Sportif",
  Standard_AVL_BCB: "CycleGen · Standard AVL (BCB)",
  Prudent: "CycleGen · Prudent (RS)",
  Dynamique: "CycleGen · Dynamique (RS)",
};""",
            1,
        )
    else:
        html = re.sub(
            r"const PRESET_LABEL_FULL = \{.*?\n\};",
            """const PRESET_LABEL_FULL = {
  Eco: "CycleGen · Eco",
  Normal: "CycleGen · Normal",
  Sportif: "CycleGen · Sportif",
  Standard_AVL_BCB: "CycleGen · Standard AVL (BCB)",
  Prudent: "CycleGen · Prudent (RS)",
  Dynamique: "CycleGen · Dynamique (RS)",
};""",
            html,
            count=1,
            flags=re.S,
        )
    # COLORS
    if "Prudent:" not in html[html.find("const COLORS") : html.find("const COLORS") + 500]:
        html = html.replace(
            'Standard_AVL_BCB: "#c9a227",',
            'Standard_AVL_BCB: "#c9a227",\n  Prudent: "#9b7edb",\n  Dynamique: "#e85d75",',
            1,
        )
    # Default enabled: matched styles + BCB for contrast
    html = re.sub(
        r"let enabledPresets = new Set\(\[[^\]]*\]\);",
        'let enabledPresets = new Set(["Prudent","Dynamique","Standard_AVL_BCB"]);',
        html,
        count=1,
    )
    # radar series: add Prudent/Dynamique if cyclegen_presets has them
    if "cg.Prudent" not in html and '"CG Prudent"' in html:
        html = html.replace(
            '"CG Std BCB": [cg.Standard_AVL_BCB.a_max, cg.Standard_AVL_BCB.b_comf, cg.Standard_AVL_BCB.jerk, cg.Standard_AVL_BCB.sf, cg.Standard_AVL_BCB.a_y],',
            '"CG Std BCB": [cg.Standard_AVL_BCB.a_max, cg.Standard_AVL_BCB.b_comf, cg.Standard_AVL_BCB.jerk, cg.Standard_AVL_BCB.sf, cg.Standard_AVL_BCB.a_y],\n'
            '    "CG Prudent": cg.Prudent ? [cg.Prudent.a_max, cg.Prudent.b_comf, cg.Prudent.jerk, cg.Prudent.sf, cg.Prudent.a_y] : [0,0,0,0,0],\n'
            '    "CG Dynamique": cg.Dynamique ? [cg.Dynamique.a_max, cg.Dynamique.b_comf, cg.Dynamique.jerk, cg.Dynamique.sf, cg.Dynamique.a_y] : [0,0,0,0,0],',
            1,
        )
    return html


def matched_scoreboard(data: dict) -> str:
    rows = []
    for tr in data.get("traces") or []:
        avl = tr.get("avl") or {}
        style = avl.get("style")
        want = "Dynamique" if style == "dynamique" else "Prudent"
        arms = {a.get("preset"): a for a in (tr.get("arms") or []) if a.get("preset")}
        best = tr.get("best") or {}
        matched = arms.get(want) or {}
        rows.append(
            "<tr>"
            f"<td>{avl.get('route_hint', '')}</td>"
            f"<td><span class='pill {style}'>{style}</span></td>"
            f"<td>{best.get('preset', '—')}</td>"
            f"<td>{best.get('rmse_v_kmh', '—')}</td>"
            f"<td>{best.get('delta_duration_pct', '—')}</td>"
            f"<td>{want}</td>"
            f"<td>{matched.get('rmse_v_kmh', '—')}</td>"
            f"<td>{matched.get('delta_duration_pct', '—')}</td>"
            "</tr>"
        )
    return "\n".join(rows)


def build_reco(data: dict) -> str:
    matched_ok = matched_n = 0
    lines = []
    stelvio = ""
    for tr in data.get("traces") or []:
        avl = tr.get("avl") or {}
        style = avl.get("style")
        want = "Dynamique" if style == "dynamique" else "Prudent"
        arms = {a.get("preset"): a for a in (tr.get("arms") or []) if a.get("preset")}
        best = tr.get("best") or {}
        matched = arms.get(want)
        if matched:
            matched_n += 1
            if best.get("preset") == want:
                matched_ok += 1
            lines.append(
                f"<li><strong>{avl.get('route_hint')} · {style}</strong> — "
                f"best <code>{best.get('preset')}</code> "
                f"RMSE={best.get('rmse_v_kmh')} · "
                f"assorti <code>{want}</code> "
                f"RMSE={matched.get('rmse_v_kmh')} "
                f"shape={matched.get('shape_score')} "
                f"corr={matched.get('corr_v')} "
                f"(ΔT {matched.get('delta_duration_pct')}%)</li>"
            )
        if avl.get("route_hint") == "Stelvio" and style == "dynamique" and matched:
            bcb = arms.get("Standard_AVL_BCB") or {}
            stelvio = (
                f"Stelvio dynamique : Dynamique RMSE={matched.get('rmse_v_kmh')} "
                f"shape={matched.get('shape_score')} "
                f"vs Std BCB RMSE={bcb.get('rmse_v_kmh')}."
            )
    hit = f"{matched_ok}/{matched_n}" if matched_n else "n/a"
    return f"""
  <section class="panel">
    <h2>Match style AVL Route Studio ↔ preset CycleGen</h2>
    <p class="hint">Bras assorti = Prudent ou Dynamique selon le style RS. Best = plus bas RMSE_v. Shape = accord de gradient Δv sur S.</p>
    <table class="score">
      <thead>
        <tr>
          <th>Route</th><th>RS</th>
          <th>Best CG</th><th>RMSE</th><th>ΔT%</th>
          <th>Assorti</th><th>RMSE</th><th>ΔT%</th>
        </tr>
      </thead>
      <tbody>
        {matched_scoreboard(data)}
      </tbody>
    </table>
  </section>
  <section class="panel expert">
    <h2>Recommandations — dépasser AVL Route Studio (post-recalage)</h2>
    <p>
      Recalage appliqué : presets <strong>CG Prudent / Dynamique</strong>
      (a_y 3,27 / 4,9) + <strong>plant XSPACE</strong> (P=80 kW, τ_brake,
      retenue descente) + <strong>a_y zoné</strong> lacets + score forme Δv.
      Bras assorti meilleur RMSE sur <strong>{hit}</strong> traces.
    </p>
    <p>{stelvio}</p>
    <ul>
      {''.join(lines)}
    </ul>
    <h3>Livré (P1–P3)</h3>
    <ul>
      <li><strong>Véhicule en boucle</strong> — clip IDM par P_max/(m·v), τ_brake/r_dyn,
        road-load F0/F1/F2, retenue regen en descente (XSPACE 2556 kg / 80 kW).</li>
      <li><strong>Score de forme Δv</strong> — corr_v, mae/bias, shape_score (accord
        de gradient sur S) dans le batch / rapport JSON.</li>
      <li><strong>a_y zoné</strong> — alpine_ay_profile : boost hairpin (~1,25×) pour R≲35 m.</li>
    </ul>
    <h3>Priorités suivantes</h3>
    <ul>
      <li>Calibrer P_cont / regen_frac sur P95 couple/puissance par trace (Stelvio).</li>
      <li>DTW spatial ou score multi-objectif (RMSE + shape + ΔT) pour choisir le bras.</li>
      <li>Garder <strong>Std BCB</strong> pour N90 / homologation, plus comme proxy XSPACE.</li>
      <li>UI defaults XSPACE : Prudent / Dynamique (seedés) + rapport auto à chaque batch.</li>
    </ul>
    <div class="callout">
      Objectif produit : surpasser AVL Route Studio sur réalisme énergie/freins,
      traçabilité, et multi-style reproductible — pas seulement coller le RMSE_v.
    </div>
  </section>
"""


def refresh_reco_sections(html: str, data: dict) -> str:
    block = build_reco(data)
    # Remove old match + reco sections if present
    html = re.sub(
        r'<section class="panel">\s*<h2>Match style AVL Route Studio.*?</section>\s*',
        "",
        html,
        flags=re.S,
    )
    html = re.sub(
        r'<section class="panel expert">\s*<h2>Recommandations — dépasser AVL Route Studio.*?</section>\s*',
        "",
        html,
        flags=re.S,
    )
    # Insert at end of page-analyse
    m = re.search(
        r'(<div class="page[^"]*" id="page-analyse"[^>]*>)(.*?)(</div>\s*(?=<div class="page|</main>))',
        html,
        re.S,
    )
    if m:
        html = html[: m.start(3)] + "\n" + block + "\n  " + html[m.start(3) :]
    else:
        html = html.replace("<footer>", block + "\n<footer>", 1)
    return html


def update_kpi_table_from_payload(html: str, data: dict) -> str:
    """Refresh scoreboard table rows from new arms/best."""
    rows = []
    for tr in data.get("traces") or []:
        avl = tr.get("avl") or {}
        best = tr.get("best") or {}
        rows.append(
            "<tr>"
            f"<td>{avl.get('route_hint', '')}</td>"
            f"<td><span class='pill {avl.get('style', '')}'>{avl.get('style', '')}</span></td>"
            f"<td>{avl.get('v_mean_kmh', float('nan')):.1f}</td>"
            f"<td>{avl.get('a_pos_p95', float('nan')):.2f} / {avl.get('a_neg_p95', float('nan')):.2f}</td>"
            f"<td>{avl.get('a_lat_p95', float('nan')):.2f}</td>"
            f"<td>{best.get('preset', '—')}</td>"
            f"<td>{best.get('rmse_v_kmh', '—')}</td>"
            f"<td>{best.get('delta_duration_pct', '—')}</td>"
            "</tr>"
        )
    body = "\n".join(rows)
    html2, n = re.subn(
        r"(<table class=\"score\">\s*<thead>.*?Tableau de bord.*?</thead>\s*<tbody>)(.*?)(</tbody>)",
        lambda m: m.group(0),  # noop - wrong
        html,
        count=1,
        flags=re.S,
    )
    # Simpler: find first score table tbody in analyse (dashboard)
    def repl_first_tbody(match: re.Match[str]) -> str:
        return match.group(1) + body + match.group(3)

    html, n = re.subn(
        r"(<h2>Tableau de bord — meilleur bras par trace</h2>[\s\S]*?<tbody>)([\s\S]*?)(</tbody>)",
        repl_first_tbody,
        html,
        count=1,
    )
    return html


def polish_all() -> None:
    generated = _CALIB / "xspace_avl_report_latest.html"
    if not generated.exists():
        raise FileNotFoundError(generated)
    payload = extract_payload(generated.read_text(encoding="utf-8"))

    # Prefer shell with good UI; fall back to docs then generated
    if _SHELL.exists():
        shell = _SHELL.read_text(encoding="utf-8")
    elif (_DOCS / "xspace_avl_calibration_report.html").exists():
        shell = (_DOCS / "xspace_avl_calibration_report.html").read_text(encoding="utf-8")
    else:
        shell = generated.read_text(encoding="utf-8")

    html = embed_payload(shell, payload)
    html = patch_js_presets(html)
    html = update_kpi_table_from_payload(html, payload)
    html = refresh_reco_sections(html, payload)

    # Ensure graphiques is default page
    html = html.replace('else showPage("analyse");', 'else showPage("graphiques");')

    targets = [
        generated,
        _DOCS / "xspace_avl_calibration_report.html",
    ]
    _DOCS.mkdir(parents=True, exist_ok=True)
    for p in targets:
        p.write_text(html, encoding="utf-8")
        print("wrote", p, f"({p.stat().st_size/1e6:.2f} MB)")

    # Refresh shell for next runs (keep UI evolution)
    _SHELL.write_text(html, encoding="utf-8")

    # Scoreboard stdout
    print("\n=== Match RS style → CG preset ===")
    for tr in payload.get("traces") or []:
        avl = tr["avl"]
        style = avl["style"]
        want = "Dynamique" if style == "dynamique" else "Prudent"
        arms = {a["preset"]: a for a in tr.get("arms") or [] if "preset" in a}
        best = tr.get("best") or {}
        m = arms.get(want) or {}
        print(
            f"  {avl['route_hint']} · {style}: "
            f"best={best.get('preset')} RMSE={best.get('rmse_v_kmh')} | "
            f"{want} RMSE={m.get('rmse_v_kmh')} ΔT={m.get('delta_duration_pct')}%"
        )


if __name__ == "__main__":
    polish_all()
