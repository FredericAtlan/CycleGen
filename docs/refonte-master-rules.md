# MASTER RULES UX / ARCHITECTURE — Refonte CycleGen

À coller en prompt agent, ou via [`.cursor/rules/refonte-cyclegen.mdc`](../.cursor/rules/refonte-cyclegen.mdc).  
Détail produit : [`docs/refonte-studios-brief.md`](refonte-studios-brief.md).

Tu dois concevoir cette refonte comme un **IDE d’ingénierie** (AVL / Simulink / Cursor), pas une app SaaS grand public. La vérité scientifique et la performance priment sur le design web conventionnel.

## 1. Paradigme workspace (pas de silos)

- Le parcours principal n’est **pas** une navigation par URLs (`/?mode=driver`, etc.).
- Interface dominante = Workspace IDE unifié :

```text
[ Explorateur d'assets G ] [ Canvas : Carte & Courbes sync ] [ Inspecteur D ]
[ -------------- Console / Warnings / RMSE / logs -------------- ]
```

- Le Hub / Accueil sert uniquement à l’onboarding ou aux projets récents ; il ne casse pas la boucle une fois le projet ouvert.
- **Non-régression** : `/?mode=create` (CycleGenShell), library, Versus, simulate — restent fonctionnels pendant la migration progressive.

## 2. Inspecteurs et CRUD

- Édition Conducteur / Véhicule = panneau **Inspecteur** (entité sélectionnée à gauche).
- **Exceptions ingestion lourde** : batch fingerprint 8 XLS Route Studio, comparaison de banques → **modales denses** ou **drawers** dédiés (pas un inspecteur 200 px).

## 3. Dichotomie d’exécution (cheap vs expensive)

| Classe | Exemples | UX |
|--------|----------|-----|
| **Cheap — Update dynamics** | IDM (`a_max`, `pedal_tau_s`, …), post-process véhicule | Re-calcul debounced **50–100 ms**, sans bouton Générer |
| **Expensive — Rebuild corridor** | HERE/OSRM/Mapbox, élévation, feux | Action **explicite** ; label « Rebuild corridor » |
| **Heavy async** | Geometry-lock fit multi-variants | `POST …/jobs` + poll / WS — jamais sync bloquant |

## 4. Synchronisation spatio-temporelle (Zustand)

- Lier `hoverIndex` / `playhead` Recharts ↔ marqueur Leaflet ↔ courbe de pente.
- Ledger 3 strates : (1) config, (2) géométrie immuable côté client, (3) résultats séries.
- Pas de gros JSON corridor/traces dans l’URL.
- Types TS alignés Pydantic ; zéro métier lourd dans React.

## 5. Austérité visuelle (zéro bullshit UI)

- Thème slate/brand CycleGen (pas MarketChain).
- Typo **monospace** pour scalaires et KPIs.
- Couleur strictement sémantique (ex. rouge = danger / freinage &lt; −1 m/s² / anomalie).
- Tableaux denses ; pas d’ombres décoratives.

## 6. Non-régression & artefacts batch RS

- E2E Playwright + `POST /api/simulate/start` = verts à chaque commit de phase.
- Préserver : pedal lag solver, scripts/pack Route Studio, exports CSV/XLS/OEM, Versus, calibration HTML/CSV.
- Pedal schema default **0** ; fingerprint + **SHA-256** fichier source ; banques async (Dexie).
- Thin FastAPI routers ; vérité = `kinematic_solver` + services `rs_*`.
- Scripts batch conservés jusqu’à couverture tests.

## 7. Migration de poste (rappel)

- Export UI JSON cycles + dump console `cyclegen.*` + corridor IndexedDB.
- Copier `.env` ; recrear `.venv` / `npm install` propres — ne jamais copier binaires.

## 8. Avant de coder

1. Relire ce fichier + brief § IDE.  
2. Périmètre fichiers de la phase seulement.  
3. Implémenter.  
4. Smoke e2e + health.  
5. Stop — pas d’enchaînement sans feu vert.
