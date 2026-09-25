import type { BenchmarkSourceMeta } from "./types";

export const CORPUS_FAMILY_ORDER = [
  "oem",
  "alpine",
  "xspace_avl",
  "regulatory",
  "demo",
  "ved",
  "geolife",
] as const;

export const CORPUS_FAMILY_LABEL: Record<string, string> = {
  oem: "OEM / constructeur",
  alpine: "Cols alpins (stress freins)",
  xspace_avl: "AVL XSPACE (calibration)",
  regulatory: "Réglementaire / standard",
  demo: "Démo CycleGen",
  ved: "VED (GPS réel)",
  geolife: "GeoLife (GPS réel)",
};

/** Group benchmark sources for <optgroup> selects. */
export function groupBenchmarkSources(
  sources: BenchmarkSourceMeta[]
): { family: string; label: string; items: BenchmarkSourceMeta[] }[] {
  const buckets = new Map<string, BenchmarkSourceMeta[]>();
  for (const s of sources) {
    const fam = (s.family || "regulatory").toLowerCase();
    const list = buckets.get(fam) ?? [];
    list.push(s);
    buckets.set(fam, list);
  }
  const ordered: { family: string; label: string; items: BenchmarkSourceMeta[] }[] =
    [];
  for (const fam of CORPUS_FAMILY_ORDER) {
    const items = buckets.get(fam);
    if (items?.length) {
      ordered.push({
        family: fam,
        label: CORPUS_FAMILY_LABEL[fam] ?? fam,
        items,
      });
      buckets.delete(fam);
    }
  }
  for (const [fam, items] of Array.from(buckets.entries())) {
    ordered.push({
      family: fam,
      label: CORPUS_FAMILY_LABEL[fam] ?? fam,
      items,
    });
  }
  return ordered;
}
