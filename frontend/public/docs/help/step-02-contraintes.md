# Étape 2 — Contraintes

> Objectif : transformer la route analysée en **cycle spatial** — enveloppes de vitesse, pente, feux — avant toute simulation micro.

## Flux UI

```text
┌─────────────────────────────────────────────────────────────┐
│  SIDEBAR · Contraintes                                      │
│                                                             │
│  ┌─ Pente & algorithme ────────────────────────────────┐   │
│  │ 1) min/max imposés · 2) L · lissage · clamp        │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─ Profil de pente ───────────────────────────────────┐   │
│  │ 3) impact · unité %/°/rad · chart 1 km · observés  │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─ Feux tricolores ───────────────────────────────────┐   │
│  │ Avec / Sans · édition S_feux · tls_mode             │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─ Enveloppes ────────────────────────────────────────┐   │
│  │ masques Légal ∩ Trafic ∩ Virage                     │   │
│  └─────────────────────────────────────────────────────┘   │
│  CTA → « Construire le cycle »                              │
└──────────────────────────┬──────────────────────────────────┘
                           │ POST /api/corridor/build
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  SpatialCorridor                                            │
│  S, α, V_legal, V_traffic, V_curve, V_envelope, S_feux, z   │
└─────────────────────────────────────────────────────────────┘
```

Changer lissage, **taille des trapèzes L**, clamp ou bornes α déclenche en principe un **rebuild** du cycle spatial (mêmes géométrie / segments, nouvelle chaîne altitude → pente). Les masques d’enveloppe s’appliquent surtout **côté client** sans forcément rappeler l’API.

---

## Calcul de la pente \(\alpha(s)\) — guide détaillé

Cette section décrit **exactement** ce que fait CycleGen entre le DEM de l’étape 1 et le profil de pente du cycle spatial. Code : `spatial_processor.py` (`prepare_elevations`, `local_slope_rad`, `clip_alpha_to_grade_pct`).

### 1. Ce qu’on cherche

Le long de l’abscisse curviligne \(S\) (distance parcourue en mètres depuis A), on veut un angle de pente \(\alpha(s)\) en **radians** :

\[
\alpha(s)=\operatorname{atan}\!\left(\frac{\mathrm{d}z}{\mathrm{d}s}\right)
\]

où \(z\) est l’altitude (m) et \(s\) la distance le long du tracé.

| Quantité | Rôle |
|----------|------|
| \(S_i\) | Positions cumulées des sommets de la polyligne |
| \(z_i^{\mathrm{DEM}}\) | Altitudes brutes (lookup DEM étape 1) |
| \(z_i\) | Altitudes **corrigées** (après pont/tunnel + clamp) |
| \(z_i^{\mathrm{SG}}\) | Altitudes **lissées** (Savitzky–Golay) |
| \(\alpha_i\) | Pente locale stockée / utilisée par le solveur |

**Signe :** \(\alpha > 0\) = montée, \(\alpha < 0\) = descente.

### 2. Chaîne complète (vue d’ensemble)

```text
Étape 1 — RouteAnalyzeResponse.elevations_m[]
        │  (un z par sommet de géométrie, aligné sur S)
        ▼
┌───────────────────────────────────────────┐
│  A. Correction pont / tunnel OSM          │
│     → interpolation linéaire de z         │
└─────────────────────┬─────────────────────┘
                      ▼
┌───────────────────────────────────────────┐
│  B. Clamp |dz/ds| ≤ max_grade             │
│     → réparation des marches DEM          │
│     (param. UI « Clamp grade max »)       │
└─────────────────────┬─────────────────────┘
                      ▼
              z corrigé  (= elevations_m du corridor)
                      │
                      ▼
┌───────────────────────────────────────────┐
│  C. Lissage Savitzky–Golay sur z (opt.)   │
│     Fin / Normal / Fort                   │
└─────────────────────┬─────────────────────┘
                      ▼
┌───────────────────────────────────────────┐
│  D. α par paliers trapézoïdaux de longueur│
│     L = trap_length_m (défaut 50 m)       │
│     + agrégation slope_profile (bandes 1 km)│
└─────────────────────┬─────────────────────┘
                      ▼
┌───────────────────────────────────────────┐
│  E. Clip optionnel α min/max (% grade)    │
│     bornes dures post-calcul              │
└─────────────────────┬─────────────────────┘
                      ▼
              α(s) + slope_profile + warnings
              (+ détection spikes résiduels)
```

### 2bis. Trapèzes L et profil 1 km

Le paramètre UI **Taille des trapèzes (m)** (`trap_length_m`, presets 25 / 50 / 100 / 200, plage 10–500) découpe le profil en segments de longueur ≈ L. Sur chaque trapèze on calcule une pente constante (Δz / Δs). Ces trapèzes sont ensuite agrégés en **bandes de 1 km** (`slope_profile.km_segments`) avec moyenne, min, max et écart-type de pente (%).

L’UI Contraintes affiche un **profil d’altitude** (style col cycliste) : courbes z(s), remplissage coloré par |moyenne %| sur chaque km, badge `Trapèzes L = … m`. Clic sur un km → détail des trapèzes. Si `slope_profile` est absent, reconstruire le cycle.

### 3. Étape A — Ponts et tunnels

Le DEM « voit » souvent le **sol** sous un pont ou le **relief** au-dessus d’un tunnel, pas la chaussée.

1. Overpass (étape 1) fournit des `road_structures` (`bridge` / `tunnel`) avec extrémités géographiques.
2. Chaque extrémité est accrochée au sommet de polyligne le plus proche (indices \(i_0\), \(i_1\)).
3. Entre \(i_0\) et \(i_1\), \(z\) est remplacé par une **interpolation linéaire** entre \(z(i_0)\) et \(z(i_1)\) le long de \(S\) :

\[
z(S_k)=z_{i_0}+\frac{S_k-S_{i_0}}{S_{i_1}-S_{i_0}}\,(z_{i_1}-z_{i_0})
\]

Warning typique : `elevation_structure_interp`.

Ce n’est **pas** un scan laser de la dalle : c’est une imputation documentée pour éviter des « murs » de pente artificiels.

### 4. Étape B — Clamp \(\lvert dz/ds\rvert\) (réparation DEM)

Même hors pont, un DEM public peut sauter de plusieurs mètres entre deux sommets proches → grade absurde (ex. 80 %).

**Définition grade (rise/run) :**

\[
g_i=\frac{z_i-z_{i-1}}{S_i-S_{i-1}}
\quad\text{(sans unité ; }15\,\%\equiv 0{,}15\text{)}
\]

Si \(\lvert g_i\rvert > \texttt{max\_grade}\) :

1. On étend la fenêtre jusqu’à un couple de points \((i-1,\,j)\) dont le grade moyen est acceptable, sinon jusqu’à la fin.
2. On **réécrit** \(z\) par interpolation linéaire sur \([S_{i-1}, S_j]\).

Paramètre UI **Clamp grade max** :

| Valeur UI | `max_grade` | Effet |
|-----------|-------------|--------|
| 15 % (défaut) | 0,15 | Répare les marches DEM hors alpin « raisonnable » |
| 25 % | 0,25 | Plus permissif (descentes alpines fortes) |
| 40 % / 100 % / 500 % | 0,4 … 5 | Quasi désactive cette réparation |

Warning : `elevation_grade_clamp`.

**Attention :** un clamp trop bas peut aplatir une **vraie** descente alpine ; un clamp trop haut laisse passer du bruit DEM.

### 5. Étape C — Lissage Savitzky–Golay sur \(z\)

On ne dérive **pas** le DEM brut pour \(\alpha\) : on lisse d’abord \(z\).

Le filtre **Savitzky–Golay** ajuste localement un polynôme (ordre typique 2–3) sur une fenêtre de points, puis retient la valeur au centre. Avantage : atténue le bruit tout en préservant mieux les tendances que une moyenne mobile naïve.

CycleGen impose aussi un **span physique minimum** (mètres le long de \(S\)) : la fenêtre en nombre de points est augmentée si besoin pour couvrir au moins `sg_min_span_m`.

| Preset UI | `smooth_window` | `sg_min_span_m` | `polyorder` | Usage |
|-----------|-----------------|----------------|------------|--------|
| **Fin** | **5** pts | **15 m** | **3** | Garde le détail DEM — pics locaux possibles |
| **Normal** (défaut) | **11** pts | **30 m** | **3** | Compromis Studio |
| **Fort** | **21** pts | **60 m** | **3** | Atténue fortement les pics DEM (et les reliefs courts) |

**Pas de couplage** avec le clamp grade : le clamp (`max_grade`, ex. 0,15 = 15 %) intervient **avant**, sur le DEM brut ; le SG lisse ensuite \(z\). Les deux curseurs sont indépendants.

Résultat : série \(z^{\mathrm{SG}}(S)\).

### 6. Étape D — Calcul de \(\alpha\) par paliers L

Après le lissage, la pente n’est plus nécessairement dérivée sommet à sommet uniquement : le backend découpe \(S\) en **trapèzes** de longueur nominale \(L = \texttt{trap\_length\_m}\) (défaut 50 m). Sur chaque intervalle \([s_0, s_1]\) :

\[
\alpha_{\mathrm{trap}}=\operatorname{atan}\!\left(\frac{z(s_1)-z(s_0)}{s_1-s_0}\right)
\]

Ces trapèzes alimentent aussi `slope_profile` (stats par km). Le graphique α(s) du Studio reste l’échantillonnage dense du corridor ; le **profil d’altitude** visualise les bandes 1 km.

Pour chaque sommet \(i \ge 1\) (chemin historique / dense) :

\[
\Delta s_i = S_i - S_{i-1},\qquad
\alpha_i=\operatorname{atan}\!\left(\frac{z^{\mathrm{SG}}_i - z^{\mathrm{SG}}_{i-1}}{\Delta s_i}\right)
\]

- Si \(\Delta s_i\) est trop petit → on reprend \(\alpha_{i-1}\) (stabilité numérique).
- \(\alpha_0\) est aligné sur \(\alpha_1\).

C’est une pente **par segment**, pas une dérivée analytique continue. Le solveur (étape 3) lit \(\alpha\) le long de \(s\) (souvent par interpolation / échantillonnage du corridor).

### 7. Étape E — Bornes imposées (optionnel)

Après le calcul, l’UI peut forcer une pente min / max en **% grade** (ex. −12 % … +12 %).

Conversion :

\[
\alpha_{\mathrm{min}}=\operatorname{atan}(\mathrm{min\_pct}/100),\quad
\alpha_{\mathrm{max}}=\operatorname{atan}(\mathrm{max\_pct}/100)
\]

Puis clip dur : \(\alpha \leftarrow \mathrm{clip}(\alpha,\,\alpha_{\mathrm{min}},\,\alpha_{\mathrm{max}})\).

- Champ vide = pas de contrainte.
- Warning : `slope_alpha_clip` (nombre d’échantillons touchés).

Utile pour des scénarios **bornés** (démo, cahier des charges), pas pour « corriger » le DEM.

### 8. Unités d’affichage (≠ unité de calcul)

| Unité UI | Formule | Où |
|----------|---------|-----|
| **rad** | \(\alpha\) | Stockage solveur / profil `slope[]` |
| **°** | \(\alpha\cdot 180/\pi\) | Graphiques |
| **%** | \(100\cdot\tan\alpha\) | Graphiques, KPIs, export `slope_pct` |

Le toggle % / ° / rad **ne recalcule pas** la pente : il change seulement l’affichage. L’export Excel utilise le % grade.

Relation pratique (petites pentes) : \(5\,\% \approx 0{,}05\,\mathrm{rad} \approx 2{,}9^\circ\) ; pour de fortes pentes, \(\%\neq\) « degrés × constante » — toujours passer par \(\tan\) / \(\operatorname{atan}\).

### 9. Contrôles UI ↔ paramètres API

| Contrôle sidebar | Paramètre `corridor/build` | Effet |
|------------------|----------------------------|--------|
| Taille des trapèzes L | `trap_length_m` | Étape D — paliers + `slope_profile` |
| Lissage Fin/Normal/Fort | `smooth_window`, `sg_min_span_m` | Étape C |
| Clamp grade max (+ valeur %) | `max_grade` (rise/run) | Étape B |
| Pente imposée min / max % | `alpha_min_pct`, `alpha_max_pct` | Étape E |
| Unité % / ° / rad | — (front only) | Affichage |

Rebuild : même géométrie / segments que l’étape 1 ; seule la chaîne \(z\to\alpha\) est rejouée.

### 10. Warnings à lire

| Code | Signification |
|------|----------------|
| `elevation_structure_interp` | \(z\) interpolé sur un pont / tunnel |
| `elevation_grade_clamp` | Marche DEM réparée car \(\lvert dz/ds\rvert\) trop fort |
| `slope_alpha_clip` | Bornes min/max imposées ont tronqué des samples |
| `slope_spike_residual` | Après SG, \(\lvert\alpha\rvert\) encore très élevé (~≥ 0,20 rad ≈ 20 % grade) — vérifier tags OSM / DEM |

Les **pente min / max observées** dans l’accordéon Profil de pente sont les extrêmes de \(\alpha(s)\) **après** toute la chaîne (dans l’unité choisie).

### 11. Limites du modèle

- DEM public ≠ levé topographique de chantier.
- Interpolation pont/tunnel = hypothèse linéaire, pas géométrie 3D de l’ouvrage.
- Lissage Fort peut effacer un vrai col court autant qu’un artefact.
- La pente du cycle spatial est une entrée du solveur / de la mécanique (grade \(mg\sin\alpha\)) ; elle n’est **pas** recalculée pendant la simulation IDM sauf si vous reconstruisez le cycle.

### 12. Schéma numérique (exemple)

```text
S (m)     0     20     40     60
z DEM    100   101    130    102     ← pic DEM aberrant à S=40
           │
           ▼ clamp 15 %
z corr.  100   101   ~101.5  102     ← marche réparée
           │
           ▼ SG Normal (~30 m)
z SG     100  100.7  101.2  102
           │
           ▼ α = atan(Δz/Δs)
α (rad)   —   ~0.035  ~0.025  ~0.040
α (%)     —   ~3.5 %   ~2.5 %  ~4.0 %
```

---

## Enveloppes de vitesse

```text
          V_legal(s)     (annotation route)
                │
          V_traffic(s)   (fluide à depart_at, ou = legal si OSRM)
                │
          V_curve(s) = √(a_y · R(s))   confort latéral
                │
                ▼
     V_envelope = min( sources cochées )
                │
                ▼
     (alias historique V_limite pour le solveur)
```

| Source | Origine | Masque UI |
|--------|---------|-----------|
| \(V_{legal}\) | Routeur / annotations | Légal |
| \(V_{traffic}\) | Durées Mapbox ou free-flow | Trafic |
| \(V_{curve}\) | Courbure polyligne + \(a_y\) | Virage |

- Décocher une source **relâche** la contrainte correspondante dans le \(\min\).
- \(a_y\) (souvent réglé à l’étape 3) contrôle \(V_{curve}\) : plus \(a_y\) est bas, plus les virages freinent.

---

## Feux

```text
OSM traffic_signals
        │ projection ortho sur polyligne
        │ rejet si distance latérale > ~5 m
        ▼
   S_feux + feux_meta.tls_mode
        │  green_wave (axes primary/trunk espacés)
        │  stochastic (sinon)
        ▼
   UI : Avec / Sans feux · édition manuelle · modes
```

| Mode UI | Effet |
|---------|--------|
| **Avec feux** | Conserve / restaure \(S_{\mathrm{feux}}\) projetés |
| **Sans feux** | \(S_{\mathrm{feux}}=\emptyset\) pour la simulation |
| Édition liste | Ajout / suppression / déplacement le long de \(S\) |
| `tls_mode` | Stratégie de freinage / phases côté solveur (étape 3) |

La projection latérale limite les faux positifs (feux d’une voie parallèle).

---

## Impacts des paramètres

| Paramètre | Formule / effet | Risque si mal réglé |
|-----------|-----------------|---------------------|
| **Trapèzes L trop courts (25 m)** | Plus de détail / bruit local | Stats 1 km plus volatiles |
| **Trapèzes L trop longs (200 m)** | Moyenne sur grands paliers | Efface des cols courts |
| **Lissage Fort** | Fenêtre SG large (~60 m) | Atténue pics DEM **et** vrais reliefs courts |
| **Clamp DEM 15 %** | Répare \(\lvert dz/ds\rvert > 0{,}15\) | Peut aplatir une vraie descente alpine |
| **Clamp 100–500 %** | Quasi pas de réparation DEM | Conserve des marches DEM aberrantes |
| **Pente imposée min −12 %** | \(\alpha \ge \mathrm{atan}(-0{,}12)\) | Borne **dure** post-calcul |
| **a_y** | \(V_{curve}=\sqrt{a_y R}\) | a_y bas → ralentit plus en virage |
| **Masques enveloppe** | \(\min\) des sources cochées | Décocher « virage » = plus de \(V_{curve}\) |
| **Sans feux** | \(S_{\mathrm{feux}}=\emptyset\) | Cycle sans arrêts TLS |

---

## Échanges API

```text
UI ──buildCorridor(route, L, smooth, max_grade, α_min/max, a_y)──► API
API ──SpatialCorridor + slope_profile + warnings + elevations_m──► UI
UI ──applique masques enveloppe côté client──► charts / sim
```

Corps typique : géométrie / segments de l’étape 1 + options `trap_length_m` / `smooth_window` / `sg_min_span_m` / `max_grade` / `alpha_min_pct` / `alpha_max_pct` / `a_y_mps2` / inclusion TLS.

Code : `routes_corridor.py`, `spatial_processor.py`, `curvature.py`.

---

## Points techniques à ne pas manquer

- **Construire le cycle ne simule pas** \(v(t)\) — uniquement les contraintes spatiales.
- Un rebuild d’altitude **ne recalcule pas** l’itinéraire Mapbox/OSRM.
- Après build, l’étape 3 lit \(V_{\mathrm{envelope}}\) (et les masques actifs) comme \(v_0\) cible pour l’IDM.
- Éditer les feux ici ou à l’étape 4 **sans régénérer** laisse l’ancien \(v(t)\) inchangé.

## Suite

Cycle spatial prêt → **Comportement** (étape 3) : `POST /api/simulate/start` + WebSocket.
