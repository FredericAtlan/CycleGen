/** Catalog of scientific help chapters (served from /docs/science/). */

export type ScienceDocMeta = {
  id: string;
  file: string;
  title: string;
  summary: string;
};

export const SCIENCE_DOCS: ScienceDocMeta[] = [
  {
    id: "readme",
    file: "README.md",
    title: "Sommaire",
    summary: "Index de la documentation scientifique CycleGen",
  },
  {
    id: "00",
    file: "00-vue-ensemble.md",
    title: "Vue d’ensemble",
    summary: "Objectif, pipeline, glossaire",
  },
  {
    id: "01",
    file: "01-routage-trafic.md",
    title: "Routage & trafic",
    summary: "Mapbox, OSRM, depart_at, traffic_source",
  },
  {
    id: "02",
    file: "02-corridor-spatial.md",
    title: "Cycle spatial",
    summary: "Pente, courbure, enveloppes de vitesse",
  },
  {
    id: "03",
    file: "03-feux-tls.md",
    title: "Feux & TLS",
    summary: "Onde verte conditionnelle vs stochastique",
  },
  {
    id: "04",
    file: "04-idm-markov.md",
    title: "IDM & Markov",
    summary: "Suivi de véhicule et bruit asymétrique",
  },
  {
    id: "05",
    file: "05-moteurs-sumo-idm.md",
    title: "SUMO vs IDM",
    summary: "Deux moteurs et fallback",
  },
  {
    id: "06",
    file: "06-benchmark-recalage.md",
    title: "Benchmark & recalage",
    summary: "Corpus, KPIs, injection, comparaison",
  },
  {
    id: "07",
    file: "07-limites-bonnes-pratiques.md",
    title: "Limites & bonnes pratiques",
    summary: "Warnings, non-claims, checklist",
  },
];

export function scienceDocUrl(file: string): string {
  return `/docs/science/${file}`;
}
