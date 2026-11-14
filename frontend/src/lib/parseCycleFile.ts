/** Parse uploaded driving-cycle files (CSV / TSV / CycleGen XML / GPX). */

const EARTH_R_M = 6_371_000;

export type ParsedCycleFile = {
  name: string;
  source: string;
  time: number[];
  /** m/s */
  velocity: number[];
  position?: number[];
  acceleration?: number[];
  a_lat?: number[];
  slope?: number[];
  slopeIsPercent?: boolean;
  lat?: number[];
  lon?: number[];
};

function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const dφ = φ2 - φ1;
  const dλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function stemName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() || filename;
  return base.replace(/\.[^.]+$/, "") || base;
}

function velocityFromGps(
  time: number[],
  lat: number[],
  lon: number[]
): number[] {
  const n = time.length;
  const v = Array.from({ length: n }, () => 0);
  for (let i = 1; i < n; i++) {
    const dt = Math.max(time[i] - time[i - 1], 1e-6);
    v[i] = haversineM(lat[i - 1], lon[i - 1], lat[i], lon[i]) / dt;
  }
  if (n > 1) v[0] = v[1];
  return v;
}

function normHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\[\]()%]/g, "")
    .replace(/[/\-\s]+/g, "_");
}

function detectDelimiter(headerLine: string): string {
  const candidates: [string, number][] = [
    ["\t", (headerLine.match(/\t/g) || []).length],
    [";", (headerLine.match(/;/g) || []).length],
    [",", (headerLine.match(/,/g) || []).length],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ",";
}

function splitRow(line: string, delim: string): string[] {
  if (delim !== ",") return line.split(delim).map((c) => c.trim());
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      q = !q;
      continue;
    }
    if (ch === "," && !q) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function toNum(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

type ColKind =
  | "time"
  | "velocity_mps"
  | "velocity_kmh"
  | "velocity_mph"
  | "velocity_unknown"
  | "position"
  | "acceleration"
  | "a_lat"
  | "slope_pct"
  | "slope_rad"
  | "slope_unknown"
  | "lat"
  | "lon";

function classifyHeader(h: string): ColKind | null {
  if (
    h === "lat" ||
    h === "latitude" ||
    h.endsWith("_lat") ||
    h === "y_lat"
  ) {
    return "lat";
  }
  if (
    h === "lon" ||
    h === "lng" ||
    h === "long" ||
    h === "longitude" ||
    h.endsWith("_lon")
  ) {
    return "lon";
  }
  if (
    h === "time" ||
    h === "t" ||
    h === "time_s" ||
    h === "temps" ||
    h === "temps_s" ||
    h === "timestamp" ||
    h === "sec" ||
    h === "seconds"
  ) {
    return "time";
  }
  if (
    h.includes("a_lat") ||
    h.includes("alat") ||
    h === "ay" ||
    h === "a_y"
  ) {
    return "a_lat";
  }
  if (
    h.includes("accel") ||
    h === "a_lon" ||
    h === "a" ||
    h === "ax"
  ) {
    return "acceleration";
  }
  if (h.includes("slope") || h.includes("pente") || h.includes("grade")) {
    if (h.includes("rad")) return "slope_rad";
    if (h.includes("pct") || h.includes("percent") || h === "pente") {
      return "slope_pct";
    }
    return "slope_unknown";
  }
  if (
    h === "position" ||
    h === "position_m" ||
    h === "s" ||
    h === "s_m" ||
    h === "dist" ||
    h === "distance" ||
    h === "distance_m" ||
    h === "dist_m"
  ) {
    return "position";
  }
  if (
    h.includes("wheel") ||
    h.includes("motor") ||
    h.includes("rpm") ||
    h.includes("torque") ||
    h.includes("brake") ||
    h.includes("power")
  ) {
    return null;
  }
  if (
    h.includes("velocity") ||
    h.includes("vehiclespeed") ||
    h.includes("speed") ||
    h === "v" ||
    h === "vitesse" ||
    h.startsWith("vitesse_")
  ) {
    if (h.includes("kmh") || h.includes("km_h") || h.includes("kph")) {
      return "velocity_kmh";
    }
    if (h.includes("mph")) return "velocity_mph";
    if (h.includes("mps") || h.includes("m_s") || h.includes("ms")) {
      return "velocity_mps";
    }
    return "velocity_unknown";
  }
  return null;
}

const VELOCITY_KINDS: ReadonlySet<ColKind> = new Set([
  "velocity_mps",
  "velocity_kmh",
  "velocity_mph",
  "velocity_unknown",
]);

/** Prefer realized/measured speed over setpoint (sp / consigne). */
function pickVelocityColIndex(
  headers: string[],
  cols: Array<ColKind | null>
): number {
  const indices = cols
    .map((k, i) => (k && VELOCITY_KINDS.has(k) ? i : -1))
    .filter((i) => i >= 0);
  if (!indices.length) return -1;
  const prefer = (h: string) =>
    /realized|realis[eé]|mesur|actual|obs|ego/.test(h);
  const avoid = (h: string) =>
    /(?:^|_)sp(?:_|$)|setpoint|consigne|cible|target|cmd|command|ref(?:_|$)/.test(
      h
    );
  const preferred = indices.find((i) => prefer(headers[i] ?? ""));
  if (preferred != null) return preferred;
  const notAvoid = indices.find((i) => !avoid(headers[i] ?? ""));
  return notAvoid ?? indices[0];
}

function parseCsvLike(filename: string, text: string): ParsedCycleFile {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));
  if (lines.length < 2) {
    throw new Error("Fichier trop court (en-tête + au moins 2 points).");
  }

  const delim = detectDelimiter(lines[0]);
  const headers = splitRow(lines[0], delim).map(normHeader);
  const kinds = headers.map(classifyHeader);

  const hasHeader = kinds.some((k) => k != null);
  const start = hasHeader ? 1 : 0;
  const cols: Array<ColKind | null> = hasHeader
    ? kinds
    : headers.length >= 2
      ? [
          "time",
          "velocity_unknown",
          ...Array.from({ length: Math.max(0, headers.length - 2) }, () => null),
        ]
      : kinds;

  const time: number[] = [];
  const rawV: number[] = [];
  const position: number[] = [];
  const acceleration: number[] = [];
  const a_lat: number[] = [];
  const slope: number[] = [];
  const lat: number[] = [];
  const lon: number[] = [];
  let vKind: ColKind = "velocity_unknown";
  let slopeKind: ColKind = "slope_unknown";

  const vCol = pickVelocityColIndex(headers, cols);

  for (let r = start; r < lines.length; r++) {
    const cells = splitRow(lines[r], delim);
    if (cells.length < 2) continue;
    const get = (kind: ColKind): number | null => {
      const i = cols.indexOf(kind);
      if (i < 0) return null;
      return toNum(cells[i] ?? "");
    };
    const t = get("time");
    let v: number | null = null;
    if (vCol >= 0) {
      const raw = toNum(cells[vCol] ?? "");
      const kind = cols[vCol];
      if (raw != null && kind) {
        if (kind === "velocity_kmh") {
          v = raw / 3.6;
          vKind = "velocity_kmh";
        } else if (kind === "velocity_mph") {
          v = raw * 0.44704;
          vKind = "velocity_mph";
        } else if (kind === "velocity_mps") {
          v = raw;
          vKind = "velocity_mps";
        } else {
          v = raw;
          vKind = "velocity_unknown";
        }
      }
    }

    const la = get("lat");
    const lo = get("lon");
    if (t == null && v == null && (la == null || lo == null)) continue;

    time.push(t ?? time.length);
    rawV.push(v ?? 0);
    const p = get("position");
    if (p != null) position.push(p);
    const a = get("acceleration");
    if (a != null) acceleration.push(a);
    const al = get("a_lat");
    if (al != null) a_lat.push(al);
    const sp =
      get("slope_pct") ?? get("slope_rad") ?? get("slope_unknown");
    if (sp != null) {
      slope.push(sp);
      if (get("slope_pct") != null) slopeKind = "slope_pct";
      else if (get("slope_rad") != null) slopeKind = "slope_rad";
    }
    if (la != null) lat.push(la);
    if (lo != null) lon.push(lo);
  }

  if (time.length < 2) {
    throw new Error("Pas assez de points numériques dans le fichier.");
  }

  // Unix / epoch timestamps → relative seconds
  if (time[0] > 1e11) {
    const t0 = time[0];
    for (let i = 0; i < time.length; i++) time[i] = (time[i] - t0) / 1000;
  } else if (time[0] > 1e9) {
    const t0 = time[0];
    for (let i = 0; i < time.length; i++) time[i] -= t0;
  }

  let velocity = rawV;
  if (
    vKind === "velocity_unknown" &&
    Math.max(...rawV.map(Math.abs)) > 55
  ) {
    velocity = rawV.map((x) => x / 3.6);
  }

  const n = time.length;
  const haveGps = lat.length === n && lon.length === n;
  if (haveGps && velocity.every((x) => x === 0)) {
    velocity = velocityFromGps(time, lat, lon);
  }

  return {
    name: stemName(filename),
    source: `import · ${filename}`,
    time,
    velocity,
    position: position.length === n ? position : undefined,
    acceleration: acceleration.length === n ? acceleration : undefined,
    a_lat: a_lat.length === n ? a_lat : undefined,
    slope: slope.length === n ? slope : undefined,
    slopeIsPercent: slopeKind !== "slope_rad",
    lat: haveGps ? lat : undefined,
    lon: haveGps ? lon : undefined,
  };
}

function parseCycleGenXml(filename: string, text: string): ParsedCycleFile {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("XML illisible.");
  }
  const samples = Array.from(doc.querySelectorAll("sample"));
  if (samples.length < 2) {
    throw new Error("XML CycleGen : moins de 2 échantillons.");
  }
  const num = (el: Element, attr: string) => {
    const v = el.getAttribute(attr);
    return v != null ? Number(v) : NaN;
  };
  const time: number[] = [];
  const velocity: number[] = [];
  const position: number[] = [];
  const acceleration: number[] = [];
  const slope: number[] = [];
  for (const s of samples) {
    const t = num(s, "time");
    const v = num(s, "velocity");
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    time.push(t);
    velocity.push(v);
    const p = num(s, "position");
    const a = num(s, "acceleration");
    const sl = num(s, "slope");
    if (Number.isFinite(p)) position.push(p);
    if (Number.isFinite(a)) acceleration.push(a);
    if (Number.isFinite(sl)) slope.push(sl);
  }
  const n = time.length;
  return {
    name: stemName(filename),
    source: `import · ${filename}`,
    time,
    velocity,
    position: position.length === n ? position : undefined,
    acceleration: acceleration.length === n ? acceleration : undefined,
    slope: slope.length === n ? slope : undefined,
    slopeIsPercent: false,
  };
}

function parseGpx(filename: string, text: string): ParsedCycleFile {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("GPX illisible.");
  }
  const pts = Array.from(doc.querySelectorAll("trkpt, rtept"));
  if (pts.length < 2) {
    throw new Error("GPX : moins de 2 points de trace.");
  }
  const time: number[] = [];
  const lat: number[] = [];
  const lon: number[] = [];
  let t0: number | null = null;
  pts.forEach((pt, i) => {
    const la = Number(pt.getAttribute("lat"));
    const lo = Number(pt.getAttribute("lon"));
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
    const iso = pt.querySelector("time")?.textContent?.trim();
    let t = i;
    if (iso) {
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) {
        if (t0 == null) t0 = ms;
        t = (ms - t0) / 1000;
      }
    }
    time.push(t);
    lat.push(la);
    lon.push(lo);
  });
  if (time.length < 2) throw new Error("GPX : points GPS invalides.");
  const velocity = velocityFromGps(time, lat, lon);
  return {
    name: stemName(filename),
    source: `import · ${filename}`,
    time,
    velocity,
    lat,
    lon,
  };
}

export function parseCycleFile(filename: string, text: string): ParsedCycleFile {
  const lower = filename.toLowerCase();
  const head = text.slice(0, 400).toLowerCase();
  if (lower.endsWith(".gpx") || head.includes("<gpx") || head.includes("<trkpt")) {
    return parseGpx(filename, text);
  }
  if (
    lower.endsWith(".xml") ||
    head.includes("<cyclegen") ||
    head.includes("<samples")
  ) {
    if (head.includes("<gpx")) return parseGpx(filename, text);
    return parseCycleGenXml(filename, text);
  }
  return parseCsvLike(filename, text);
}

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "text" in v) {
    return String((v as { text?: string }).text ?? "");
  }
  return String(v);
}

function cellNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = cellStr(v).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse CycleGen Excel export (onglet Profil) or a simple sheet with t / v columns. */
export async function parseCycleXlsx(
  filename: string,
  data: ArrayBuffer
): Promise<ParsedCycleFile> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const sheet =
    wb.getWorksheet("Profil") ||
    wb.worksheets.find((ws) => /profil|cycle|data/i.test(ws.name)) ||
    wb.worksheets[0];
  if (!sheet) throw new Error("Excel : aucun onglet trouvé.");

  let headerRow = 0;
  let headersNorm: string[] = [];
  let kinds: Array<ColKind | null> = [];

  sheet.eachRow((row, rowNumber) => {
    if (headerRow) return;
    const values = row.values;
    if (!Array.isArray(values)) return;
    const cells = values.map((c) => normHeader(cellStr(c)));
    const classified = cells.map((h) => (h ? classifyHeader(h) : null));
    if (
      classified.some((k) => k === "time") &&
      classified.some((k) => k != null && VELOCITY_KINDS.has(k))
    ) {
      headersNorm = cells;
      kinds = classified;
      headerRow = rowNumber;
    }
  });

  const vCol = pickVelocityColIndex(headersNorm, kinds);
  const tCol = kinds.indexOf("time");
  const sCol = kinds.findIndex((k) => k === "position");

  if (headerRow === 0 || tCol < 0 || vCol < 0) {
    throw new Error(
      "Excel : colonnes temps / vitesse introuvables (attendu Temps + Vitesse realized, ou t_s / v_mps)."
    );
  }

  const vKind = kinds[vCol];
  const vIsKmh = vKind === "velocity_kmh";
  const vIsMph = vKind === "velocity_mph";

  const time: number[] = [];
  const velocity: number[] = [];
  const position: number[] = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const values = row.values;
    if (!Array.isArray(values)) return;
    const t = cellNum(values[tCol]);
    let v = cellNum(values[vCol]);
    if (t == null || v == null) return;
    if (vIsKmh) v = v / 3.6;
    else if (vIsMph) v = v * 0.44704;
    time.push(t);
    velocity.push(v);
    if (sCol >= 0) {
      const s = cellNum(values[sCol]);
      if (s != null) position.push(s);
    }
  });

  if (time.length < 2) {
    throw new Error("Excel : moins de 2 points vitesse/temps.");
  }

  // If median v > 70, likely km/h mistaken as m/s
  const sortedV = [...velocity].sort((a, b) => a - b);
  const med = sortedV[Math.floor(sortedV.length / 2)] ?? 0;
  const vel =
    !vIsKmh && !vIsMph && med > 70 ? velocity.map((x) => x / 3.6) : velocity;

  return {
    name: stemName(filename),
    source: `import · ${filename}`,
    time,
    velocity: vel,
    position: position.length === time.length ? position : undefined,
  };
}

export async function parseCycleBlob(file: File): Promise<ParsedCycleFile> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const buf = await file.arrayBuffer();
    return parseCycleXlsx(file.name, buf);
  }
  const text = await file.text();
  return parseCycleFile(file.name, text);
}
