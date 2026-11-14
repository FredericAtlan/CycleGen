/** Studio step help + science catalog for the help drawer. */

import type { StudioWizardStep } from "@/components/StudioStepper";

export type HelpTab = "step" | "architecture" | "science";

export type StepHelpMeta = {
  step: StudioWizardStep;
  id: string;
  file: string;
  title: string;
  summary: string;
};

export const STEP_HELP_DOCS: StepHelpMeta[] = [
  {
    step: 1,
    id: "step-1",
    file: "step-01-trajet.md",
    title: "Étape 1 — Trajet",
    summary: "A/B, waypoints, routage, trafic, altitude",
  },
  {
    step: 2,
    id: "step-2",
    file: "step-02-contraintes.md",
    title: "Étape 2 — Contraintes",
    summary: "Pente, feux, enveloppes, algorithme altitude",
  },
  {
    step: 3,
    id: "step-3",
    file: "step-03-comportement.md",
    title: "Étape 3 — Conducteur",
    summary: "IDM/SUMO, profil, véhicule, génération",
  },
  {
    step: 4,
    id: "step-4",
    file: "step-04-resultats.md",
    title: "Étape 4 — Cycle",
    summary: "Profils, mécanique, export, Versus",
  },
];

export const ARCHITECTURE_HELP = {
  id: "architecture",
  file: "architecture-modeles.md",
  title: "Architecture & modèles",
  summary: "Stack, pipeline API, choix IDM/SUMO/DEM",
};

export function stepHelpUrl(file: string): string {
  return `/docs/help/${file}`;
}

export function stepHelpFor(step: StudioWizardStep): StepHelpMeta {
  return (
    STEP_HELP_DOCS.find((d) => d.step === step) ?? STEP_HELP_DOCS[0]
  );
}
