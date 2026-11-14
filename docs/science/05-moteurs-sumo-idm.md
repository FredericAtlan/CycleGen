# 05 — Moteurs de simulation : IDM vs SUMO

## 1. Deux moteurs, un même cycle spatial

Les deux moteurs consomment le **même** `SpatialCorridor` (enveloppes, feux, pente).  
Ils ne produisent **pas** des trajectoires bit-identiques.

| Aspect | IDM interne | SUMO / TraCI |
|--------|-------------|--------------|
| Dynamique | IDM + Markov sparse + gate | Car-following SUMO (`accel`, `decel`, `tau`, `sigma`) |
| Bruit | TPM documentée | `sigma` / `speedDev` (autre nature) |
| Feux | Planificateur conditionnel CycleGen | `tlLogic` / guess netconvert |
| Multi-agents | Ego seul (`density≈0`) | Trafic possible si réseau riche |
| Fallback | — | Si SUMO indisponible → **IDM auto** |

## 2. Le moteur SUMO — échelle multi-agents

**SUMO** (*Simulation of Urban MObility*) n’est pas une simple équation : c’est un **logiciel complet** de simulation de trafic open-source développé par le **DLR**. Il simule des réseaux entiers où chaque véhicule (parfois des dizaines de milliers) a son propre comportement.

### Comment ça fonctionne ?

Au lieu d’un seul véhicule sur une ligne idéale, SUMO crée un **écosystème** :

1. Import d’un quartier depuis OpenStreetMap (voies multiples, feux, priorités).
2. Génération d’un flux de véhicules aléatoires (*background traffic*).
3. Insertion du **véhicule sous test** dans ce trafic.
4. Calcul des interactions à chaque pas de temps (changements de file, refus de priorité, ondes de stop-and-go).

### TraCI (*Traffic Control Interface*)

**TraCI** permet au backend Python CycleGen de **piloter en live** la simulation SUMO : lire la vitesse d’un véhicule, forcer un feu au rouge, etc. C’est le bridge vers le WebSocket et le `ConsolidatedProfile`.

### Quand l’utiliser dans CycleGen ?

SUMO vise l’**urbain dense** (ex. domicile–travail en Île-de-France) : profil chaotique, riche en stop-and-go. Peu pertinent pour un col type Grossglockner où le trafic n’est pas le facteur dimensionnant freins.

## 3. Sélection runtime

1. L’utilisateur demande `engine: "sumo"` ou `"idm"`  
2. Si SUMO échoue (Docker absent, netconvert, TraCI) → bascule IDM + log  
3. Frames live via WebSocket ; à l’arrêt → `ConsolidatedProfile`

## 4. Parité paramétrique (pas identité)

Les `vType` SUMO reprennent volontairement \(a_{\max}\), freinage, `speedFactor` des presets Eco/Normal/Agressif.  
C’est une **parité de réglage**, pas une preuve d’équivalence trajectoire.

## 5. Synthèse — lequel choisir (Wizard étape 3) ?

| Critère | Moteur IDM (par défaut) | Moteur SUMO |
|---------|-------------------------|-------------|
| Cas d’usage idéal | Descentes de cols, enveloppes maximales, limites physiques, routes libres | Milieu urbain, embouteillages dynamiques, ondes de choc de trafic |
| Besoins en calcul | Ultra-léger (quelques ms). Python direct | Lourd (binaire SUMO / Docker en arrière-plan) |
| Focus d’ingénierie | Validation thermique freins, usure, limites chaîne de traction | Stress-test batterie (VE) ou conso en ville |
| Inputs requis | Polyligne + pentes + limites (corridor spatial) | Réseau complet (`.net.xml`) + voies |
| Reproductibilité | Forte (seed + Markov documenté) | Moins bit-identique (trafic stochastique) |

| Besoin concret | Recommandation |
|----------------|----------------|
| Reproductibilité scientifique du bruit Markov | **IDM** |
| Exploration multi-véhicules / réseau | **SUMO** (si image Docker healthy) |
| Smoke test rapide sans Docker | **IDM** |

## 6. Fichiers code

- `backend/app/services/simulation_manager.py`
- `backend/app/services/sumo_bridge.py`
- `backend/app/services/sumo_session.py`
- `sumo/templates/`, `sumo/README.md`
