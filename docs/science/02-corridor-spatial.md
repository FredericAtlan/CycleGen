# 02 — Cycle spatial et enveloppes de vitesse

## 1. Pourquoi

Le routage donne une polyligne et des vitesses **par segment**. Le solveur micro a besoin d’un objet **échantillonnable** le long de \(s\) :

\[
\big(S,\; \alpha(s),\; V_{legal}(s),\; V_{traffic}(s),\; V_{curve}(s),\; V_{envelope}(s),\; S_{\mathrm{feux}}\big)
\]

C’est le **cycle spatial**.

## 2. Abscisse curviligne \(S\)

On cumule les longueurs de segments (préférentiellement fournies par le routeur, sinon haversine).  
\(S=0\) au départ, \(S=L\) à l’arrivée.

\(S\) mesure la distance parcourue le long de la polyligne du trajet (abscisse curviligne), et non une coordonnée géographique fixe comme la latitude.

## 3. Projection orthogonale des feux (règle des 5 m)

Chaque feu OSM est projeté sur la polyligne en coordonnées locales équirectangulaires.

- Si distance **latérale** \(> 5\,\mathrm{m}\) → **rejeté** (`signal_rejected_5m`)
- Déduplication le long de \(S\) (~15 m)

Pourquoi ? Un feu sur une voie parallèle ne doit pas arrêter le véhicule sur *votre* corridor.

## 4. Topographie et pente \(\alpha(s)\)

Guide détaillé (UI Contraintes) : fiche d’aide **Étape 2 — Calcul de la pente**.

### 4.1 Chaîne de traitement de \(z\)

1. **Pont / tunnel OSM** — interpolation linéaire de \(z\) entre extrémités de structure  
2. **Clamp grade** — si \(\lvert dz/ds\rvert > \texttt{max\_grade}\) (défaut 0,15 ≈ 15 %) → réparation par interpolation linéaire sur la fenêtre fautive  
3. **Savitzky–Golay** sur \(z\) — **indépendant** du clamp : Fin `smooth_window=5`, `sg_min_span_m=15` ; Normal `11` / `30` ; Fort `21` / `60` (polyordre 3)  
4. **Pente par paliers trapézoïdaux** de longueur \(L = \texttt{trap\_length\_m}\) (défaut 50 m) + agrégation `slope_profile` (bandes 1 km : mean / min / max / σ %) ; pente locale dense :

\[
\alpha_i=\operatorname{atan}\!\left(\frac{z^{\mathrm{SG}}_i-z^{\mathrm{SG}}_{i-1}}{S_i-S_{i-1}}\right)\quad[\mathrm{rad}]
\]

5. **Clip optionnel** — bornes \(\alpha\) en % grade (`alpha_min_pct` / `alpha_max_pct`) converties via \(\operatorname{atan}(\%/100)\)

Warnings : `elevation_structure_interp`, `elevation_grade_clamp`, `slope_alpha_clip`, `slope_spike_residual`.

### 4.2 Affichage % / ° / rad

L’UI peut afficher :

| Unité | Formule d’affichage |
|-------|--------------------|
| rad | \(\alpha\) |
| ° | \(\alpha\cdot 180/\pi\) |
| % | \(100\cdot\tan(\alpha)\) |

**Important :** option **d’affichage** uniquement. Le solveur et le profil stockent \(\alpha\) en radians ; l’export utilise souvent `slope_pct`.

Le Studio affiche aussi un **profil d’altitude** (bandes 1 km colorées par |moyenne %|, badge \(L\)).

### 4.3 Paramètres UI ↔ API

| UI | API `corridor/build` |
|----|----------------------|
| Taille des trapèzes L | `trap_length_m` |
| Lissage Fin/Normal/Fort | `smooth_window`, `sg_min_span_m` |
| Clamp grade max | `max_grade` (rise/run) |
| Pente imposée min/max | `alpha_min_pct`, `alpha_max_pct` |

## 5. Courbure et \(V_{curve}\)

Rayon local \(R(s)\) : circumradius de triplets de points successifs, lissé, borné.

Accélération latérale de confort \(a_y\) (défaut \(2{,}5\,\mathrm{m/s^2}\)) :

\[
V_{curve}(s)=\sqrt{a_y\, R(s)}
\]

À rayon \(R\) plus petit, \(V_{curve}=\sqrt{a_y R}\) diminue ; la limite provient uniquement de l’accélération latérale de confort \(a_y\).  
Ce n’est **pas** un modèle de frottement pneu/chaussée ni de dévers.

## 6. Enveloppe finale

\[
V_{envelope}(s)=\min\big(V_{legal}(s),\, V_{traffic}(s),\, V_{curve}(s)\big)
\]

Dans le code, le champ historique `V_limite` est un **alias** de \(V_{envelope}\) pour le solveur / SUMO.

Le véhicule désirera (après facteur conducteur) une vitesse \(\le V_{envelope}\).

## 7. Limites

- DEM ≠ levé topographique  
- \(V_{curve}\) = confort latéral, pas limite physique absolue  
- Ponts : \(z\) interpolé = imputation documentée, pas scan laser

## 8. Fichiers code

- `backend/app/services/spatial_processor.py`
- `backend/app/services/curvature.py`
- `frontend/src/lib/units.ts`, `frontend/src/lib/paramDocs.ts`
