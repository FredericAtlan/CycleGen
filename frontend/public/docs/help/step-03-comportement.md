# Étape 3 — Comportement

> Objectif : choisir **comment** le véhicule suit l’enveloppe (moteur + conducteur + véhicule), puis **générer** le cycle \(v(t)\).

## Flux UI

```text
┌─────────────────────────────────────────────────────────────┐
│  SIDEBAR · Comportement                                     │
│                                                             │
│  ┌─ Vmax · Virage · Bruit ─────────────────────────────┐   │
│  │ Vmax véhicule (km/h)                                │   │
│  │ Latéral en virage a_y (m/s²) — V_curve ∝ √a_y       │   │
│  │ Bruit stochastique Markov (IDM)                     │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─ Moteur ────────────┐  IDM (défaut) | SUMO               │
│  └─────────────────────┘                                    │
│  ┌─ Conducteur ────────────────────────────────────────┐   │
│  │ Profil Eco / Normal / Agressif / Sportif            │   │
│  │ a_max, b_comf, speed_factor (ou % Sportif)          │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─ Zones conducteur (optionnel, par tronçons de S) ──┐   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─ Véhicule ──────────────────────────────────────────┐   │
│  │ masse, F0/F1/F2, r_dyn → P / couple (analyse)       │   │
│  └─────────────────────────────────────────────────────┘   │
│  CTA → « Générer le cycle » / « Appliquer et générer »      │
└──────────────────────────┬──────────────────────────────────┘
                           │ POST /api/simulate/start
                           │ WS  /api/simulate/ws/{id}
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Live → ConsolidatedProfile (t, v, a, α, s, …)              │
└─────────────────────────────────────────────────────────────┘
```

Si les paramètres conducteur ont changé depuis le dernier run, le CTA peut afficher **Appliquer et générer** (régénération avec la physique à jour).

---

## Boucle de simulation

```text
UI                    FastAPI                 Moteur
 │  start(corridor,     │                       │
 │   driver, engine)    │                       │
 │─────────────────────►│  spawn session        │
 │◄── simulation_id ────│                       │
 │  WS connect          │                       │
 │─────────────────────►│──────────────────────►│ step Δt
 │◄──── frames (t,v,a,s,α,tls) ─────────────────│
 │  stop / consolidate  │                       │
 │─────────────────────►│  flush profile        │
 │◄── ConsolidatedProfile                       │
```

Le profil consolidé contient au minimum : `time`, `velocity` (m/s), `acceleration`, `slope` (rad), `position`, KPIs (`total_duration_s`, `average_speed_kmh`), `traffic_source`, `warnings`, et éventuellement des métriques d’audit (clip, Markov, RPA).

---

## Moteur IDM (défaut)

### Échelle : microscopique « solo »

L’**Intelligent Driver Model (IDM)** est un modèle mathématique **continu** de suivi de véhicule (*car-following*). Développé au début des années 2000, c’est une référence pour le comportement **longitudinal** d’un conducteur donné : dynamique réaliste, sans à-coups aberrants.

Dans CycleGen, l’échelle est **microscopique solo** : on simule **un** véhicule qui suit la trajectoire / l’enveloppe du corridor (limites, virages, feux, pente), pas un trafic multi-agents riche (rôle plutôt de SUMO).

### Comment ça fonctionne ?

À chaque pas de temps (ordre du dixième de seconde côté solveur), l’IDM calcule l’accélération instantanée \(\frac{\mathrm{d}v}{\mathrm{d}t}\) en résolvant une équation différentielle qui **équilibre deux volontés** du conducteur :

1. **Accélérer** vers une vitesse cible \(v_0\) (route libre).
2. **Freiner** pour maintenir une distance de sécurité \(s^*\) face à un obstacle (feu rouge, virage serré via \(V_{\mathrm{curve}}\), ou ralentissement d’enveloppe / véhicule lent devant).

Accélération désirée (forme IDM) :

\[
\dot v = a\left(1-\left(\frac{v}{v_0}\right)^\delta\right)
- a\left(\frac{s^*}{s}\right)^2
\]

avec

\[
v_0 = \min(V_{\mathrm{envelope}}, V_{\mathrm{vehicle}})\cdot \mathrm{speed\_factor}
\]

\[
s^* = s_0 + vT + \frac{v\,\Delta v}{2\sqrt{a\,b}}
\]

### Paramètres clés (boutons de réglage du profil)

| Symbole | Rôle | Source UI / code |
|---------|------|------------------|
| \(v_0\) | Vitesse désirée (Vmax / limite locale majorée ou minorée) | \(V_{\mathrm{envelope}}\), Vmax, `speed_factor` |
| \(a\) | Accélération max (« kick-down ») | `a_max` |
| \(b\) | Décélération de confort (freinage standard avant l’urgence) | `b_comf` |
| \(T\) | Time headway / marge temporelle (ex. ~1,5 s) | Profil conducteur |
| \(s_0\) | Distance d’arrêt minimale (pare-chocs à l’arrêt) | Profil conducteur |
| \(V_{\mathrm{envelope}}\) | Cible spatiale (légal ∩ trafic ∩ virage) | Cycle spatial + masques étape 2 |
| Feux | Freinage anticipé / arrêt selon `tls_mode` | Corridor \(S_{\mathrm{feux}}\) |
| Markov | Micro-variations d’accélération | TPM Eco / Normal / Sport — **gate** en freinage fort |

Le bruit Markov module l’accélération désirée ; le **gate** coupe ce bruit quand le freinage est déjà fort (stabilité / réalisme).

### Pourquoi c’est adapté aux tests de freinage (ex. Col de l’Iseran) ?

L’IDM est **déterministe** et **continu**. Alimenté avec la topologie alpine (chaque virage impose une \(V_{\mathrm{curve}}\) via l’accélération latérale \(a_y\)), il produit une courbe de freinage **fluide**, mathématiquement propre, proche d’un conducteur qui anticipe le lacet.

Il fournit ainsi la courbe d’accélération / décélération longitudinale \(a_{\mathrm{lon}}(t)\) utilisable pour un bilan thermique, un dimensionnement frein / batterie, ou un export d’analyse — sans artefacts de type « à-coups numériques » d’un modèle trop grossier.

Code : `kinematic_solver.py`, `markov_noise.py`.

---

## Moteur SUMO (optionnel)

### Échelle : macroscopique et multi-agents (le chaos du trafic)

**SUMO** (*Simulation of Urban MObility*) n’est pas juste une équation : c’est un **logiciel complet** de simulation de trafic open-source développé par le **DLR** (agence spatiale allemande). Il simule des réseaux routiers entiers où chaque véhicule (parfois des dizaines de milliers) possède son propre « cerveau ».

Dans CycleGen, l’échelle est **multi-agents** : interactions, changements de file, refus de priorité, vagues d’embouteillage — pas un seul ego sur une enveloppe idéale (rôle de l’IDM).

### Comment ça fonctionne ?

Au lieu de calculer un seul véhicule sur une ligne idéale, SUMO crée un **écosystème** :

1. Vous importez un quartier entier depuis OpenStreetMap (voies multiples, feux, priorités à droite).
2. SUMO génère un flux de véhicules aléatoires (*background traffic*).
3. Vous insérez votre **véhicule sous test** dans ce trafic.
4. SUMO calcule les interactions de **tous** les véhicules à chaque pas de temps (changements de file, refus de priorité, ondes de stop-and-go).

| Aspect | Détail CycleGen |
|--------|-----------------|
| Prérequis | Conteneur / binaire SUMO, réseau préparé (`.net.xml`), TraCI |
| Entrée | Corridor + paramètres véhicule / conducteur mappés en `vType` |
| Sortie | Même famille de frames → `ConsolidatedProfile` |
| Indisponible | Fallback explicite vers IDM |

### Killer-feature : TraCI (*Traffic Control Interface*)

**TraCI** est un protocole qui permet à un script Python (le backend CycleGen) de **discuter en direct** avec la simulation SUMO en cours. Exemples d’ordres :

- « Récupère la vitesse de la voiture ID 42 »
- « Force le feu au prochain carrefour à passer au rouge »

C’est ce bridge qui alimente le WebSocket live et la consolidation du profil.

### Pourquoi l’utiliser dans CycleGen ?

SUMO est fait pour l’**urbain dense**. Vous ne l’utiliserez pas pour le Grossglockner (où le trafic n’est pas le facteur dimensionnant pour les freins). Vous l’utiliserez pour un scénario du type **trajet domicile–travail en Île-de-France** : profil de vitesse chaotique, riche en stop-and-go (accélérations parasites, freinages imprévus parce qu’un autre véhicule a coupé la route).

Code : `sumo_bridge.py`, `sumo_session.py`, `sumo/templates/`.

---

## Synthèse : lequel choisir à l’étape 3 ?

| Critère | Moteur IDM (par défaut) | Moteur SUMO |
|---------|-------------------------|-------------|
| Cas d’usage idéal | Descentes de cols, enveloppes maximales, limites physiques, routes libres | Milieu urbain, embouteillages dynamiques, ondes de choc de trafic |
| Besoins en calcul | Ultra-léger (quelques millisecondes). Calculé directement en Python | Lourd (moteur binaire SUMO en arrière-plan / Docker) |
| Focus d’ingénierie | Validation thermique des freins, profil d’usure, limites de la chaîne de traction | Stress-test batterie (VE) ou consommation en ville |
| Inputs requis | Polyligne + pentes + limites de vitesse (corridor spatial) | Réseau routier complet (`.net.xml`) avec gestion des voies |
| Reproductibilité | Forte (seed + Markov documenté) | Moins bit-identique (trafic stochastique, autre car-following) |

En pratique : **IDM** pour la plupart des études frein / enveloppe / alpine ; **SUMO** quand le chaos urbain est le phénomène à capturer. Si SUMO est indisponible, CycleGen bascule sur l’IDM avec un message explicite.

---

## Impacts des paramètres conducteur

| Paramètre | Impact principal | Effet typique |
|-----------|------------------|---------------|
| **Eco** | speed_factor < 1, a_max bas | Cycle plus lent, moins d’agressivité |
| **Normal** | Réglages de référence | Baseline Studio |
| **Agressif** | speed_factor > 1, a_max haut | Plus de RPA, arrêts plus secs |
| **Sportif + %** | \(v_0 = V\cdot(1+x/100)\) | Dépassement contrôlé des limites |
| **a_max ↑** | Accel libre plus forte | Départs plus vifs |
| **b_comf ↑** | Freinage confort plus fort | Gaps plus courts, freinages plus tardifs |
| **a_y ↑** | \(V_{curve}\) plus haut | Moins de ralentissement virage |
| **Vmax** | Cap dur après enveloppe × facteur | Borne véhicule |
| **Zones** | Surcharge IDM sur \([s_0,s_1)\) | Comportement localisé le long de \(S\) |

Changer **a_y** peut nécessiter de **reconstruire** \(V_{curve}\) / l’enveloppe (cohérence avec l’étape 2) avant de simuler.

---

## Véhicule (road-load)

\[
F_{\mathrm{trac}} = F_0 + F_1 v_{\mathrm{km/h}} + F_2 v_{\mathrm{km/h}}^2
+ mg\sin\alpha + m a
\]

\[
P = F_{\mathrm{trac}}\, v,\quad
\tau = F_{\mathrm{trac}}\, r_{\mathrm{dyn}},\quad
N_{\mathrm{rpm}} = \frac{v}{r_{\mathrm{dyn}}}\cdot\frac{60}{2\pi}
\]

| Champ | Rôle |
|-------|------|
| `mass_kg` | Inertie + grade |
| `f0_n`, `f1_n_per_kph`, `f2_n_per_kph2` | Road-load WLTP-like |
| `r_dyn_m` | Couple et rpm roue |
| `v_max_kmh` | Peut peupler Vmax solveur |
| `power_kw` | Métadonnée / plafond d’affichage si utilisé |

Utilisé en **analyse** (étape 4 et export), pas pour piloter la boucle IDM (sauf Vmax). Sans véhicule sélectionné, couple / puissances / rpm restent vides à l’export.

---

## Zones conducteur

Tronçons \([s_0, s_1)\) avec physique locale (`a_max`, `b_comf`, `speed_factor`, `a_y`). Activées seulement si l’interrupteur Zones est ON. Les zones se normalisent pour éviter les chevauchements incohérents.

---

## Points techniques à ne pas manquer

- Générer sans cycle spatial (étape 2) est bloqué.
- Modifier l’itinéraire (étape 1) ou la pente/feux (étape 2) rend l’ancien profil obsolète.
- IDM et SUMO produisent le même contrat `ConsolidatedProfile` pour l’UI.
- Les métriques d’audit (`clip_hit_count`, `markov_gate_fraction`, RPA, …) aident au diagnostic, ce ne sont pas des labels réglementaires.

## Suite

Profil consolidé → **Résultats** : graphiques, mécanique, export Excel/CSV, Versus.
