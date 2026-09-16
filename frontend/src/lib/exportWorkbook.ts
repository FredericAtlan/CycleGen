/** Build CycleGen Excel (.xlsx) and enriched CSV exports. */

import ExcelJS from "exceljs";
import type { ConsolidatedProfile, LatLon, SpatialCorridor } from "@/lib/types";
import type { VehicleCard } from "@/lib/vehicleLibrary";
import type { DriverPhysics } from "@/lib/driverPresets";
import type { InspectRunMeta } from "@/lib/inspectRunMeta";
import {
  buildExportCycleRows,
  columnSeriesStats,
  EXPORT_COLUMN_KEYS,
  EXPORT_COLUMN_LABELS,
  EXPORT_COLUMN_META,
  type ExportCycleRow,
} from "@/lib/exportCycleRows";
import {
  EXPORT_CHART_SPECS,
  renderExportChartPng,
  renderRouteMapOverview,
} from "@/lib/exportCharts";
import { downloadBlob } from "@/lib/api";
import { APP_AUTHOR, APP_VERSION } from "@/lib/branding";

const GROUP_LABEL: Record<string, string> = {
  trace: "Traçabilité",
  route: "Trajet",
  sim: "Simulation",
  driver: "Conducteur",
  slope: "Pente",
  vehicle: "Véhicule",
};

function cell(v: number | string | null | undefined): string | number {
  if (v == null) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return Math.round(v * 1e6) / 1e6;
  }
  return v;
}

function writeProfilSheet(
  ws: ExcelJS.Worksheet,
  rows: ExportCycleRow[]
): void {
  const keys = EXPORT_COLUMN_KEYS;
  const stats = keys.map((k) => columnSeriesStats(rows, k));

  // —— Bloc métadonnées par colonne ——
  const rNom = ws.addRow([
    "nom",
    ...keys.map((k) => EXPORT_COLUMN_LABELS[k]),
  ]);
  rNom.font = { bold: true };

  ws.addRow([
    "description",
    ...keys.map((k) => EXPORT_COLUMN_META[k].description),
  ]);
  ws.addRow(["unité", ...keys.map((k) => EXPORT_COLUMN_META[k].unit)]);
  ws.addRow([
    "min",
    ...stats.map((s) => (s ? cell(s.min) : "")),
  ]);
  ws.addRow([
    "max",
    ...stats.map((s) => (s ? cell(s.max) : "")),
  ]);
  ws.addRow([
    "moyenne",
    ...stats.map((s) => (s ? cell(s.mean) : "")),
  ]);
  // Mean ignoring zeros — useful for p_trac / p_regen (mostly idle at 0).
  ws.addRow([
    "moyenne_actif",
    ...stats.map((s, i) => {
      if (!s) return "";
      const k = keys[i];
      if (k !== "p_regen_kw" && k !== "p_trac_kw") return "";
      return s.meanActive != null ? cell(s.meanActive) : "";
    }),
  ]);

  ws.addRow([]); // séparateur

  // —— Données temporelles ——
  const header = ws.addRow([
    "données",
    ...keys.map((k) => EXPORT_COLUMN_LABELS[k]),
  ]);
  header.font = { bold: true };

  for (const row of rows) {
    ws.addRow(["", ...keys.map((k) => cell(row[k]))]);
  }

  ws.getColumn(1).width = 12;
  keys.forEach((k, i) => {
    ws.getColumn(i + 2).width = Math.max(
      10,
      EXPORT_COLUMN_LABELS[k].length + 2,
      Math.min(28, EXPORT_COLUMN_META[k].description.length / 2)
    );
  });
}

export type CycleExportContext = {
  profile: ConsolidatedProfile;
  corridor?: SpatialCorridor | null;
  vehicle?: VehicleCard | null;
  aY?: number;
  /** Driver physics → a_lon_max / a_lon_min columns. */
  physics?: DriverPhysics | null;
  /** Fallback GPS polyline when corridor.geometry is absent. */
  geometry?: LatLon[] | null;
  runMeta?: InspectRunMeta | null;
  /** Titre de sauvegarde / export. */
  saveTitle?: string | null;
  originLat?: number | null;
  originLon?: number | null;
  destLat?: number | null;
  destLon?: number | null;
  elevationA_m?: number | null;
  elevationB_m?: number | null;
};

function sanitizeFilenamePart(raw: string, max = 60): string {
  const cleaned = raw
    .trim()
    .replace(/[^\w\-àâäéèêëïîôùûüç.+]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, max);
  return cleaned || "";
}

/** Study name for download filename: saveTitle → meta titre → GPS → trajet. */
function resolveStudyNameForFile(ctx: CycleExportContext): string | null {
  const direct = ctx.saveTitle?.trim();
  if (direct) return direct;
  const entries = ctx.runMeta?.entries ?? [];
  const titre = entries.find((e) => e.key === "titre")?.value?.trim();
  if (titre) return titre;
  const { gpsA, gpsB } = resolveExportGps(ctx);
  if (gpsA && gpsB) return `${gpsA} → ${gpsB}`;
  const route = entries.find((e) => e.key === "route")?.value?.trim();
  if (route) return route;
  return null;
}

function resolveDriverForFile(ctx: CycleExportContext): string | null {
  const entries = ctx.runMeta?.entries ?? [];
  const name = entries.find((e) => e.key === "driver_name")?.value?.trim();
  if (name) return name;
  const fromMeta = entries.find((e) => e.key === "driver")?.value?.trim();
  if (fromMeta) return fromMeta;
  return null;
}

function resolveVehicleForFile(ctx: CycleExportContext): string | null {
  const v = ctx.vehicle;
  if (v) {
    const label = (v.code || v.name || "").trim();
    if (label) return label;
  }
  const entries = ctx.runMeta?.entries ?? [];
  const fromMeta = entries.find((e) => e.key === "veh_code")?.value?.trim();
  if (!fromMeta) return null;
  // "XSPACE · XSPACE" → take first segment
  return fromMeta.split("·")[0]?.trim() || fromMeta;
}

/** cyclegen_<étude>_<conducteur>_<véhicule>_AAAAMMJJ_HHMM.ext */
function stampFilename(ext: string, ctx: CycleExportContext): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(
    d.getDate()
  )}_${p(d.getHours())}${p(d.getMinutes())}`;

  const parts = [
    sanitizeFilenamePart(resolveStudyNameForFile(ctx) ?? "profile", 40),
    sanitizeFilenamePart(resolveDriverForFile(ctx) ?? "", 20),
    sanitizeFilenamePart(resolveVehicleForFile(ctx) ?? "", 28),
  ].filter(Boolean);

  return `cyclegen_${parts.join("_")}_${stamp}.${ext}`;
}

function resolveExportGps(ctx: Pick<
  CycleExportContext,
  "originLat" | "originLon" | "destLat" | "destLon" | "corridor"
>): {
  oLat: number | null;
  oLon: number | null;
  dLat: number | null;
  dLon: number | null;
  gpsA: string;
  gpsB: string;
} {
  const geo = ctx.corridor?.geometry;
  const oLat = ctx.originLat ?? geo?.[0]?.lat ?? null;
  const oLon = ctx.originLon ?? geo?.[0]?.lon ?? null;
  const dLat =
    ctx.destLat ??
    (geo && geo.length >= 2 ? geo[geo.length - 1].lat : null);
  const dLon =
    ctx.destLon ??
    (geo && geo.length >= 2 ? geo[geo.length - 1].lon : null);
  const fmt = (lat: number | null, lon: number | null) =>
    lat != null &&
    lon != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lon)
      ? `${lat.toFixed(5)}, ${lon.toFixed(5)}`
      : "";
  return {
    oLat,
    oLon,
    dLat,
    dLon,
    gpsA: fmt(oLat, oLon),
    gpsB: fmt(dLat, dLon),
  };
}

function writeTraceRows(
  sheet: ExcelJS.Worksheet,
  meta: InspectRunMeta | null | undefined,
  startRow: number,
  ctx?: Pick<
    CycleExportContext,
    "saveTitle" | "originLat" | "originLon" | "destLat" | "destLon" | "corridor"
  >
): number {
  let r = startRow;
  const header = sheet.getRow(r);
  header.values = ["groupe", "cle", "libelle", "valeur"];
  header.font = { bold: true };
  r += 1;

  const push = (
    groupe: string,
    cle: string,
    libelle: string,
    valeur: string
  ) => {
    sheet.getRow(r).values = [groupe, cle, libelle, valeur];
    r += 1;
  };

  const { oLat, oLon, dLat, dLon, gpsA, gpsB } = resolveExportGps(ctx ?? {});

  push("Traçabilité", "app", "Application", `CycleGen v${APP_VERSION}`);
  push("Traçabilité", "author", "Auteur", APP_AUTHOR);
  push("Traçabilité", "export_at", "Exporté le", new Date().toISOString());
  if (ctx?.saveTitle?.trim()) {
    push("Traçabilité", "titre", "Nom de l’étude", ctx.saveTitle.trim());
  }
  if (gpsA) push("Trajet", "gps_depart", "GPS départ", gpsA);
  if (gpsB) push("Trajet", "gps_arrivee", "GPS arrivée", gpsB);
  if (oLat != null && Number.isFinite(oLat)) {
    push("Trajet", "origin_lat", "Latitude départ", oLat.toFixed(6));
  }
  if (oLon != null && Number.isFinite(oLon)) {
    push("Trajet", "origin_lon", "Longitude départ", oLon.toFixed(6));
  }
  if (dLat != null && Number.isFinite(dLat)) {
    push("Trajet", "destination_lat", "Latitude arrivée", dLat.toFixed(6));
  }
  if (dLon != null && Number.isFinite(dLon)) {
    push("Trajet", "destination_lon", "Longitude arrivée", dLon.toFixed(6));
  }

  if (meta?.entries.length) {
    for (const e of meta.entries) {
      if (
        e.key === "titre" ||
        e.key === "gps_depart" ||
        e.key === "gps_arrivee" ||
        e.key === "origin_lat" ||
        e.key === "origin_lon" ||
        e.key === "destination_lat" ||
        e.key === "destination_lon"
      ) {
        continue;
      }
      push(GROUP_LABEL[e.group] ?? e.group, e.key, e.label, e.value);
    }
  }

  r += 1;
  sheet.getRow(r).values = [
    "Note",
    "",
    "Détail colonnes (nom, description, unité, min, max, moyenne) + séries temporelles : onglet Profil. Courbes = images générées depuis les mêmes séries.",
  ];
  r += 1;
  return r;
}

/** Multi-sheet Excel: Tracabilite (+ carte) · Profil · Courbes · Unites. */
export async function downloadCycleExcel(
  ctx: CycleExportContext
): Promise<void> {
  const rows = buildExportCycleRows(ctx);
  const wb = new ExcelJS.Workbook();
  wb.creator = `CycleGen v${APP_VERSION}`;
  wb.created = new Date();

  // —— Tracabilite ——
  const wsTrace = wb.addWorksheet("Tracabilite", {
    properties: { defaultRowHeight: 16 },
  });
  wsTrace.columns = [
    { width: 14 },
    { width: 16 },
    { width: 22 },
    { width: 52 },
    { width: 2 },
    { width: 12 },
  ];

  const geo =
    ctx.corridor?.geometry?.length && ctx.corridor.geometry.length >= 2
      ? ctx.corridor.geometry
      : null;
  const elevs = ctx.corridor?.elevations_m;
  const elevA =
    ctx.elevationA_m ??
    (elevs?.length ? elevs[0] : null);
  const elevB =
    ctx.elevationB_m ??
    (elevs && elevs.length >= 2 ? elevs[elevs.length - 1] : null);
  const { gpsA, gpsB } = resolveExportGps(ctx);

  // Traceability table on the left (cols A–D)
  writeTraceRows(wsTrace, ctx.runMeta, 1, ctx);

  // Large overview map on the right of the metadata
  const overviewPng = await renderRouteMapOverview(geo, {
    size: 720,
    gpsA: gpsA || null,
    gpsB: gpsB || null,
    elevA_m: elevA,
    elevB_m: elevB,
    alpha:
      ctx.corridor?.alpha &&
      geo &&
      ctx.corridor.alpha.length === geo.length
        ? ctx.corridor.alpha
        : null,
  });
  if (overviewPng) {
    wsTrace.getRow(1).getCell(6).value = "Carte — trajet complet";
    wsTrace.getRow(1).getCell(6).font = { bold: true, size: 11 };
    const mapId = wb.addImage({
      base64: overviewPng,
      extension: "png",
    });
    const mapSize = 640;
    wsTrace.addImage(mapId, {
      tl: { col: 5, row: 1.2 },
      ext: { width: mapSize, height: mapSize },
    });
  }

  // —— Profil (métadonnées colonnes puis données temporelles) ——
  const wsProfil = wb.addWorksheet("Profil");
  writeProfilSheet(wsProfil, rows);

  // —— Courbes (images from Profil data) ——
  const wsCharts = wb.addWorksheet("Courbes");
  wsCharts.getRow(1).values = [
    "Courbes générées à partir des colonnes de l’onglet Profil (mêmes données que cet export).",
  ];
  wsCharts.getRow(1).font = { italic: true, color: { argb: "FF475569" } };
  wsCharts.mergeCells(1, 1, 1, 6);
  wsCharts.getRow(2).values = [
    "Les graphiques Excel natifs liés aux cellules ne sont pas disponibles dans cet export web ; les images ci-dessous sont calculées directement depuis les séries exportées.",
  ];
  wsCharts.mergeCells(2, 1, 2, 6);

  const chartSpecs = EXPORT_CHART_SPECS.filter((s) => {
    if (
      s.yKey === "p_wheel_kw" ||
      s.yKey === "wheel_torque_nm" ||
      s.yKey === "wheel_rpm"
    ) {
      return !!ctx.vehicle;
    }
    return true;
  });

  let imgRow = 3;
  const chartW = 640;
  const chartH = 220;
  // One chart per row — 2-column layout overlapped because Excel col width ≠ px.
  // ~15 pt/row → 220 px ≈ 15 rows; use 16 for spacing + title gap.
  const rowStride = 16;
  let placed = 0;

  for (const spec of chartSpecs) {
    const png = renderExportChartPng(rows, spec, {
      width: 720,
      height: 280,
    });
    if (!png) continue;
    const imageId = wb.addImage({ base64: png, extension: "png" });
    const row = imgRow + placed * rowStride;
    placed += 1;
    wsCharts.getRow(row).values = [spec.title];
    wsCharts.getRow(row).font = { bold: true, size: 11 };
    wsCharts.addImage(imageId, {
      tl: { col: 0, row: row + 0.3 },
      ext: { width: chartW, height: chartH },
    });
  }

  // —— Unites (rappel structure Profil + notes annexes) ——
  const wsUnits = wb.addWorksheet("Unites");
  wsUnits.addRow([
    "colonne",
    "unité",
    "description",
    "min",
    "max",
    "moyenne",
    "moyenne_actif",
  ]);
  wsUnits.getRow(1).font = { bold: true };
  for (const k of EXPORT_COLUMN_KEYS) {
    const s = columnSeriesStats(rows, k);
    const m = EXPORT_COLUMN_META[k];
    const showActive = k === "p_regen_kw" || k === "p_trac_kw";
    wsUnits.addRow([
      EXPORT_COLUMN_LABELS[k],
      m.unit,
      m.description,
      s ? cell(s.min) : "",
      s ? cell(s.max) : "",
      s ? cell(s.mean) : "",
      showActive && s?.meanActive != null ? cell(s.meanActive) : "",
    ]);
  }
  wsUnits.addRow([]);
  wsUnits.addRow([
    "Profil",
    "",
    "Même dictionnaire en en-tête de l’onglet Profil (lignes nom / description / unité / min / max / moyenne [/ moyenne_actif pour regen & traction]), puis les séries temporelles.",
  ]);
  wsUnits.addRow([
    "moyenne",
    "",
    "Moyenne arithmétique sur tous les échantillons (zéros inclus). Pour p_regen / p_trac, souvent diluée car la série vaut 0 hors freinage/traction.",
  ]);
  wsUnits.addRow([
    "moyenne_actif",
    "",
    "Moyenne uniquement sur les échantillons non nuls (p_regen / p_trac). Plus proche d’une puissance « pendant freinage / traction ».",
  ]);
  wsUnits.addRow([
    "Courbes",
    "",
    "Images PNG générées côté navigateur à partir des séries de l’onglet Profil.",
  ]);
  wsUnits.addRow([
    "Carte",
    "",
    "Une grande carte du trajet complet (CARTO Voyager si NEXT_PUBLIC_CARTO_API_KEY, sinon OpenStreetMap) + tracé coloré par la pente, à droite des métadonnées dans Tracabilite.",
  ]);
  wsUnits.columns = [
    { width: 18 },
    { width: 10 },
    { width: 52 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 14 },
  ];

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  downloadBlob(blob, stampFilename("xlsx", ctx));
}

/**
 * Single CSV (no multi-tabs). Traceability as `#` comment lines,
 * then full profile columns.
 */
export function downloadCycleCsvEnriched(ctx: CycleExportContext): void {
  const rows = buildExportCycleRows(ctx);
  const lines: string[] = [
    `# CycleGen v${APP_VERSION} — ${APP_AUTHOR}`,
    `# exported_at=${new Date().toISOString()}`,
    `# note=CSV cannot have multiple sheets; open the Excel export for Tracabilite + Profil + Courbes.`,
  ];
  if (ctx.saveTitle?.trim()) {
    lines.push(`# trace.titre=${ctx.saveTitle.trim().replace(/\r?\n/g, " ")}`);
  }
  const { oLat, oLon, dLat, dLon, gpsA, gpsB } = resolveExportGps(ctx);
  if (gpsA) lines.push(`# route.gps_depart=${gpsA}`);
  if (gpsB) lines.push(`# route.gps_arrivee=${gpsB}`);
  if (oLat != null && Number.isFinite(oLat)) {
    lines.push(`# route.origin_lat=${oLat.toFixed(6)}`);
  }
  if (oLon != null && Number.isFinite(oLon)) {
    lines.push(`# route.origin_lon=${oLon.toFixed(6)}`);
  }
  if (dLat != null && Number.isFinite(dLat)) {
    lines.push(`# route.destination_lat=${dLat.toFixed(6)}`);
  }
  if (dLon != null && Number.isFinite(dLon)) {
    lines.push(`# route.destination_lon=${dLon.toFixed(6)}`);
  }
  const skipKeys = new Set([
    "titre",
    "gps_depart",
    "gps_arrivee",
    "origin_lat",
    "origin_lon",
    "destination_lat",
    "destination_lon",
  ]);
  if (ctx.runMeta?.entries.length) {
    for (const e of ctx.runMeta.entries) {
      if (skipKeys.has(e.key)) continue;
      const safe = String(e.value).replace(/\r?\n/g, " ");
      lines.push(`# ${e.group}.${e.key}=${safe}`);
    }
  }
  lines.push(
    "# --- colonnes: nom | description | unité | min | max | moyenne | moyenne_actif ---"
  );
  for (const k of EXPORT_COLUMN_KEYS) {
    const m = EXPORT_COLUMN_META[k];
    const s = columnSeriesStats(rows, k);
    const fmt = (v: number | null | undefined) =>
      v == null || !Number.isFinite(v)
        ? ""
        : String(Math.round(v * 1e6) / 1e6);
    const active =
      (k === "p_regen_kw" || k === "p_trac_kw") && s?.meanActive != null
        ? fmt(s.meanActive)
        : "";
    lines.push(
      `# col.${k}|${m.description.replace(/\|/g, "/")}|${m.unit}|${fmt(s?.min)}|${fmt(s?.max)}|${fmt(s?.mean)}|${active}`
    );
  }
  lines.push(EXPORT_COLUMN_KEYS.map((k) => EXPORT_COLUMN_LABELS[k]).join(","));
  for (const r of rows) {
    lines.push(
      EXPORT_COLUMN_KEYS.map((k) => {
        const v = r[k];
        if (v == null || (typeof v === "number" && !Number.isFinite(v))) {
          return "";
        }
        if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
        return String(v);
      }).join(",")
    );
  }
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  downloadBlob(blob, stampFilename("csv", ctx));
}
