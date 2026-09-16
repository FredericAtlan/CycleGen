# Étape 4 — Résultats

> Objectif : **lire**, **valider**, **exporter** et **comparer** le cycle généré (ou un profil injecté sans GPS).

## Flux UI

```text
┌─────────────────────────────────────────────────────────────┐
│  COLONNE ANALYSE                                            │
│                                                             │
│  En-tête KPIs : durée · distance · v̄ · vmax · pente min/max │
│                                                             │
│  ┌─ ProfileCharts ─────────────────────────────────────┐   │
│  │ v(t) vs enveloppes · pente α(t) · curseur / fenêtres │   │
│  │ clic → ChartInspectDrawer                            │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌─ MechanicCharts ─────────────────────────────────────┐   │
│  │ couple · P mécanique · P traction · P regen          │   │
│  └──────────────────────────────────────────────────────┘   │
│  Feux (édition tardive) · micro-inspect · export            │
│  Save cycle · Versus                                        │
└─────────────────────────────────────────────────────────────┘
```

Sidebar étape 4 : indicateurs (KPIs) + export / sauvegarde (accordéons).

---

## Mode sans GPS (corpus / import)

```text
Bibliothèque / import v(t)
        │
        ▼
┌───────────────────┐
│ Résultats only    │  pas de trajet / corridor / sim
│ véhicule → P, τ   │  depuis v, a, α du profil
└───────────────────┘
```

Sans géométrie, \(a_{lat}\) et les enveloppes spatiales peuvent être absentes ou nulles. La mécanique road-load reste calculable si le profil porte \(v\), \(a\), \(\alpha\) et qu’un véhicule est sélectionné.

---

## KPIs

| KPI | Définition |
|-----|------------|
| Durée | \(t_N - t_0\) |
| Distance | \(s_N\) (ou intégrale \(v\,dt\) selon le chemin de calcul) |
| \(v\) moyenne / max | sur le profil |
| Pente min / max | \(100\tan\alpha\) si unité % |

---

## Graphiques profil

| Série | Contenu |
|-------|---------|
| \(v(t)\) | Vitesse simulée vs enveloppes / références si dispo |
| Pente | \(\alpha(t)\) affichée en %, ° ou rad selon le toggle |
| Sync carte | Curseur \(s\) / fenêtre brossée sur la carte si GPS |

Le drawer d’inspect permet de zoomer une série, poser des curseurs, calculer moyenne / RMS sur une fenêtre, exporter un extrait CSV avec métadonnées de run.

---

## Mécanique

```text
v(t), a(t), α(t), véhicule
        │
        ▼
   F_road + F_grade + F_inertia = F_trac
        │
        ▼
   P_mech = F_trac · v   (signée)
   τ = F_trac · r_dyn
   N_rpm = v / r_dyn · 60/(2π)
        │
        ▼
   P_trac = max(P,0)   P_brake = max(-P,0)
```

\(P_{\mathrm{brake}}\) (colonne historique `p_regen_kw`) est la **demande de freinage aux roues** : le modèle road-load ne sépare **pas** frein hydraulique et récupération machine électrique.

\(a_{lat}\) approximée : \(a_{lat} \approx v^2 a_y / V_{curve}^2\) lorsque \(V_{curve}(s)\) est connu.

Changer de véhicule **recalcule** P / τ / rpm **sans** relancer la simulation.

---

## Export

Le CSV **ne peut pas** avoir plusieurs onglets. L’export riche est un **Excel (.xlsx)** :

| Onglet | Contenu |
|--------|---------|
| **Tracabilite** | Origine, trajet, moteur, conducteur, véhicule, enveloppes, feux… |
| **Profil** | Séries temporelles (voir ci-dessous) |
| **Unites** | Légende des colonnes |

### Colonnes Profil (ordre)

**Prioritaires :** `time_s`, `v_kmh`, `slope_pct`

**Analyse :** `position_m`, `lat_deg`, `lon_deg`, `v_mps`, `a_lon_mps2`, `jerk_lon_mps3`, `a_lat_mps2`, forces (`f_road_n`, `f_grade_n`, `f_inertia_n`, `f_trac_n`), `p_wheel_kw`, `p_trac_kw`, `p_regen_kw`, `wheel_torque_nm`, `wheel_rpm`, `wheel_omega_rad_s`

Le **CSV enrichi** reprend les mêmes colonnes, avec la traçabilité en lignes de commentaires `#`. L’XML reste un export API léger (profil de base, `slope_pct`).

Sans véhicule sélectionné, les colonnes mécaniques restent vides.

---

## Sauvegarde & Versus

| Action | Effet |
|--------|-------|
| **Sauver le cycle** | Snapshot local (profil ± corridor ± métadonnées) |
| **Versus** | CompareStudio : overlay \(v(t)\), KPIs côte-à-côte, inspect multi-runs |
| Overlay base | Référence corpus injectée sur \(v(t)\) sans quitter Résultats |

---

## Impacts / actions

| Action | Effet |
|--------|-------|
| Changer véhicule | Recalcule P / couple **sans** relancer la sim |
| Éditer feux ici | Modifie le corridor ; **régénérer** pour un nouveau \(v(t)\) |
| Overlay base | Compare à un profil de référence |
| Export Excel / CSV | Traçabilité + séries d’analyse |
| Sauver | Bibliothèque locale pour Versus / reprise |

---

## Limites techniques

- Cycle **synthétique** sous contraintes géo / comportementales — pas un label d’homologation.
- Croiser warnings spatiaux, pente min/max, RPA et, si besoin, le corpus de recalage (onglet Science · Benchmark).
- Éditions tardives du corridor (feux, masques) ne mettent pas à jour \(v(t)\) tant que l’étape 3 n’est pas relancée.
