# 00 — Vue d’ensemble scientifique

## 1. Pourquoi CycleGen existe

En ingénierie automobile (consommation, émissions, dimensionnement batterie, validation ADAS soft), on a besoin de **profils de vitesse** \(v(t)\) et souvent de **pente** \(\alpha(t)\) sur un trajet donné.

Les options classiques :

| Approche | Avantage | Limite |
|----------|----------|--------|
| Cycles réglementaires (WLTP, NEDC, FTP) | Standardisés, comparables | Pas de géographie réelle A→B |
| Enregistrements GNSS / NDS | Réels | Coûteux, privacy, peu reproductibles |
| Simulation pure (SUMO, VISSIM) | Controllable | Calibrage lourd, données trafic |

**CycleGen** vise un compromis : partir d’un **itinéraire réel** (carte), construire une **enveloppe de contraintes** (limites, trafic, courbes, pente, feux), puis générer un cycle **physiquement plausible** via un modèle de suivi (IDM ± bruit Markov, ou SUMO).

## 2. Pipeline de bout en bout

```text
A, B, waypoints, depart_at, a_y
        │
        ▼
┌───────────────────┐
│ 1. Routage        │  Mapbox driving-traffic → sinon OSRM free-flow
│    + Overpass     │  feux, bridge, tunnel, highway
│    + Élévation    │  DEM → z(s)
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ 2. Cycle          │  S, α(s), V_legal, V_traffic, V_curve, V_envelope
│    spatial        │  S_feux + feux_meta (green_wave | stochastic)
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ 3. Micro          │  IDM + Markov (gate freinage)  ou  SUMO/TraCI
└─────────┬─────────┘
          ▼
┌───────────────────┐
│ 4. Export / Bench │  ConsolidatedProfile + KPIs vs corpus
└───────────────────┘
```

## 3. Glossaire express (débutants)

| Symbole | Unité | Sens intuitif |
|---------|-------|---------------|
| \(S\) ou \(s\) | m | Distance parcourue le long de la route (abscisse curviligne) |
| \(v\) | m/s | Vitesse longitudinale |
| \(a\) | m/s² | Accélération longitudinale |
| \(\alpha\) | rad | Angle de pente (stocké en radians ; affichable en %, °) |
| \(V_{legal}\) | m/s | Vitesse « réglementaire / annotation » de la route |
| \(V_{traffic}\) | m/s | Vitesse fluide estimée (congestion) |
| \(V_{curve}\) | m/s | Vitesse limitée par le confort en virage |
| \(V_{envelope}\) | m/s | Minimum des trois — vitesse désirée de base |
| \(a_y\) | m/s² | Accélération latérale de confort (défaut 2,5) |
| \(a_{\max}\), \(b_{\mathrm{comf}}\) | m/s² | Accélération max / freinage confort (IDM) |
| IDM | — | *Intelligent Driver Model* (suivi de véhicule) |
| TPM | — | Matrice de transition Markov (bruit d’accélération) |
| TLS | — | Feux (*Traffic Light System*) |

## 4. Les quatre étapes UI

1. **Route** — points A/B, heure de départ, analyse Mapbox/OSRM  
2. **Cycle** — graphiques \(\alpha(s)\), enveloppes, feux éditables  
3. **Simulation** — génération live \(v(t), a(t), \alpha(t)\)  
4. **Export / Benchmark** — profil consolidé, comparaison corpus, sauvegardes  

## 5. Métadonnées scientifiques (à traiter comme des données)

Tout résultat sérieux doit conserver :

- `traffic_source` (`mapbox_traffic` ou `osrm_freeflow`)
- `warnings[]` (imputations : ponts, rejet de feux > 5 m, etc.)
- paramètres conducteur (`Eco` / `Normal` / `Agressif` + overrides)
- `depart_at`, `a_y`

Sans ces champs, un cycle \(v(t)\) seul n’est **pas** auditable.

## 6. Où aller ensuite

- Détail routage → [01-routage-trafic.md](01-routage-trafic.md)  
- Enveloppes & topo → [02-corridor-spatial.md](02-corridor-spatial.md)  
- Limites globales → [07-limites-bonnes-pratiques.md](07-limites-bonnes-pratiques.md)
