# 03 — Feux tricolores (TLS)

## 1. Pourquoi ce n’est pas « pile ou face »

Une première approximation (50 % rouge à chaque feu, indépendamment) produit des cycles irréalistes sur axes structurants : trop d’arrêts, pas d’onde verte.

CycleGen utilise une **règle conditionnelle** :

- sur artères espacées → **onde verte synthétique**
- sinon → **déphasage stochastique reproductible** (seed)

## 2. Métadonnées `feux_meta`

Chaque feu a :

- position \(s_{\mathrm{feu}}\)
- `tls_mode` ∈ {`green_wave`, `stochastic`}
- éventuellement classe `highway` OSM projetée

## 3. Critères d’onde verte

Un feu est candidat `green_wave` si :

1. `highway ∈ {primary, trunk}`  
2. Espacement par rapport au feu précédent (ou voisin) \(\ge 500\,\mathrm{m}\)

Sinon : `stochastic`.

## 4. Modèle de phase (IDM)

Paramètres par défaut typiques :

- cycle \(T_{cyc} = 90\,\mathrm{s}\)
- vert \(T_g = 35\,\mathrm{s}\)

### Onde verte

\[
\mathrm{offset}=\left(\frac{s_{\mathrm{feu}}}{v_{local}}\right)\bmod T_{cyc},
\quad v_{local}=\max\big(V_{envelope}(s),1\big)
\]

L’idée : un véhicule qui suit l’enveloppe « arrive au vert » de façon cohérente le long de l’axe.

### Stochastique

Offset uniforme sur \([0,T_{cyc})\), RNG seedé par la position (reproductible pour un même seed / même \(s\)).

Rouge si phase \(\ge T_g\) ; durée d’arrêt approximée \(T_{cyc}-\mathrm{phase}\).

En mode `green_wave`, les offsets de phase sont alignés pour qu’un véhicule roulant à \(V_{envelope}\) rencontre le vert le long de l’axe. En mode `stochastic`, l’offset est tiré uniformément sur \([0,T_{cyc})\) avec une seed déterministe : deux exécutions avec la même seed produisent le même scénario, sans coordination entre feux.

## 5. Limites

Ce n’est **pas** :

- un plan de feux réel (SCATS, SCOOT, priorités bus),
- une garantie OSM (présence d’un nœud ≠ programme horaire).

SUMO utilise aussi des logiques TLS (`netconvert --tls.guess`) qui **ne sont pas bit-à-bit** identiques au planificateur IDM.

## 6. Fichiers code

- `assign_tls_modes` — `spatial_processor.py`
- `_plan_lights` — `kinematic_solver.py`
- Éditeur UI — `TrafficLightsEditor.tsx`
