# 07 — Limites, warnings et bonnes pratiques

## 1. Non-claims (à afficher aux décideurs)

CycleGen **ne revendique pas** :

1. Vérité terrain absolue  
2. Conformité réglementaire WLTP/NEDC officielle  
3. Trafic = mesure flotte GNSS  
4. DEM = levé géomètre  
5. Feux = programme réel de carrefour  
6. TPM Markov = base NDS redistribuée  
7. Identité trajectoire SUMO ≡ IDM+Markov  

## 2. Warnings comme données scientifiques

Chaque `CycleGenWarning` porte `code`, `message`, intervalle \(s_0,s_1\).

Codes fréquents :

| Code | Signification |
|------|----------------|
| `osrm_freeflow` | Pas d’enveloppe congestion |
| `mapbox_fallback` | Échec Mapbox → OSRM |
| `elevation_flat` | Pente peu fiable |
| `elevation_structure_interp` | Pont/tunnel interpolé |
| `elevation_grade_clamp` | Grade irréaliste réparé |
| `signal_rejected_5m` | Feu hors corridor |

**Règle d’or :** un rapport d’étude qui cite un cycle CycleGen doit joindre `traffic_source` + la liste des warnings.

## 3. Smoke test recommandé (Vague 1)

1. Trajet nominal en pointe **avec** token Mapbox → \(v\) sous \(V_{legal}\) souvent  
2. Sans token → badge OSRM + free-flow  
3. Observer \(a(t)\) : micro-variations Markov qui **disparaissent** au freinage fort  
4. Chip Sidebar **A · Pointe/Nuit** (re-analyze `depart_at`) puis bandeau **Audit sécurité** sur le profil — pas d’onglet Scénarios séparé  

## 4. Checklist avant publication

- [ ] `depart_at` cohérent avec le cas (pointe / nuit / chip A)  
- [ ] Badge trafic compris (Mapbox vs OSRM)  
- [ ] Warnings / Imputations lus (ponts, feux rejetés, murs de pente E)  
- [ ] Profil conducteur documenté (ou bras C Eco/Normal/Agressif)  
- [ ] Benchmark : préciser si ref est proxy réglementaire ou GPS same-route (H)  
- [ ] Export + sauvegarde applicative pour reproductibilité  

## 5. Évolutions futures (hors Vague 1)

Densité SUMO multi-agents, WLTP/NEDC officiels, OpenDRIVE, DEM local, rejector physique avancé, auto-calibration.

## 6. Navigation

Retour sommaire → [README.md](README.md)
