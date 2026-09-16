# 04 — IDM et bruit de Markov asymétrique

## 1. Pourquoi un modèle de suivi ?

Connaître \(V_{envelope}(s)\) ne suffit pas : un véhicule réel **accélère et freine** avec inertie, distance de sécurité, et micro-variations (nervosité).

### 1.1 Le moteur IDM — échelle microscopique « solo »

L’**Intelligent Driver Model (IDM)** est un modèle mathématique **continu** de suivi de véhicule (*car-following*). Développé au début des années 2000, c’est une référence pour le comportement **longitudinal** d’un conducteur spécifique : dynamique réaliste, sans à-coups aberrants.

**Échelle :** microscopique « solo » — la physique de **suivi de trajectoire / d’enveloppe** pour **un** véhicule, pas un trafic multi-agents (plutôt le rôle de SUMO).

**Principe :** à chaque pas de temps, l’IDM calcule \(\frac{\mathrm{d}v}{\mathrm{d}t}\) en équilibrant deux volontés :

1. accélérer vers la vitesse cible \(v_0\) (route libre) ;
2. freiner pour respecter une distance de sécurité \(s^*\) (feu, virage via \(V_{\mathrm{curve}}\), ralentissement d’enveloppe).

**Boutons de réglage :** \(v_0\) (désirée), \(a\) / `a_max` (kick-down), \(b\) / `b_{\mathrm{comf}}\) (freinage confort), \(T\) (time headway), \(s_0\) (gap à l’arrêt).

**Intérêt pour les freinages type Iseran :** modèle déterministe et continu. Avec une topologie où chaque virage impose \(V_{\mathrm{curve}}\) via \(a_y\), l’IDM produit une courbe de freinage fluide — un conducteur qui anticipe le lacet — et donc une \(a_{\mathrm{lon}}(t)\) propre pour un bilan thermique ou une analyse frein / énergie.

CycleGen utilise l’IDM plus un **bruit d’accélération** issu d’une chaîne de Markov, **coupé** dès qu’un freinage critique est détecté.

## 2. IDM — équations

Pas de temps \(\Delta t = 1\,\mathrm{s}\), exposant libre \(\delta = 4\).

Accélération désirée :

\[
a_{\mathrm{IDM}}=a_{\max}\left(
  1-\left(\frac{v}{v_0}\right)^{\delta}
  -\left(\frac{s^*}{s}\right)^{2}
\right)
\]

Écart désiré :

\[
s^{*}=s_0+v\,T+\frac{v\,\Delta v}{2\sqrt{a_{\max}\,b_{\mathrm{comf}}}}
\]

où :

- \(v_0\) = vitesse désirée  
- \(s\) = gap au leader (feu rouge = leader arrêté, ou ralentissement d’enveloppe)  
- \(T\) = interdistance temporelle  
- \(s_0\) = gap minimal à l’arrêt  

### Vitesse désirée

\[
v_0=\max\big(0{,}1,\; V_{envelope}(s)\cdot \texttt{speed\_factor}\big)
\]

éventuellement bornée par une vitesse max véhicule \(V_{vehicle}\).

## 3. Profils Eco / Normal / Agressif

| Profil | \(a_{\max}\) | \(b_{\mathrm{comf}}\) | `speed_factor` | \(T\) | \(s_0\) |
|--------|--------------|------------------------|----------------|-------|--------|
| Eco | 1,5 | 3,0 | 0,90 | 1,4 | 2,5 |
| Normal | 2,6 | 4,5 | 1,00 | 1,0 | 2,5 |
| Agressif | 3,8 | 6,5 | 1,15 | 0,7 | 1,5 |

Ces valeurs sont **indépendantes** de la TPM Markov (le profil fixe la dynamique IDM ; la TPM ajoute un résidu).

## 4. Bruit Markov \(a_{\mathrm{noise}}\)

### 4.1 États

- Bin de vitesse : \(v_{\mathrm{bin}}=\lfloor v/10\rfloor\) (m/s)  
- Bin d’accélération : \(-1,0,1\) selon le signe de \(a\) autour de \(\pm 0{,}5\,\mathrm{m/s^2}\)

Clé sparse JSON : `"v_bin,a_bin"` → distribution sur \(a_{\mathrm{noise}}\).

État manquant → \(a_{\mathrm{noise}}=0\) (pas de crash).

### 4.2 Gate de freinage critique (asymétrie)

Le bruit est **forcé à zéro** si :

1. distance au danger \(< d_{\mathrm{brake}}=\max\!\big(v^2/(2b_{\mathrm{comf}}),\,25\big)\), **ou**  
2. \(a_{\mathrm{IDM}}\le -1\,\mathrm{m/s^2}\)

Puis :

\[
a=\operatorname{clip}\big(a_{\mathrm{IDM}}+a_{\mathrm{noise}},\; -1{,}5\,b_{\mathrm{comf}},\; a_{\max}\big)
\]

**Pourquoi ?** Sur un freinage d’urgence / feu, ajouter du « jitter » Markov est **physiquement et sécuritairement absurde**. On veut de la nervosité en roulage libre, pas pendant un arrêt d’urgence.

### 4.3 Intégration Euler

\[
v\leftarrow v+a\,\Delta t,\qquad s\leftarrow s+v_{\mathrm{old}}\,\Delta t
\]

## 5. Synthèse du modèle

- **IDM** : dynamique de suivi avec accélération/freinage bornés et respect de \(V_{envelope}\).  
- **Markov** : résidu d’accélération conditionné à la vitesse et au signe de \(a\), actif en roulage libre.  
- **Gate** : annulation du bruit Markov dès qu’un freinage critique est détecté (proximité du danger ou \(a_{\mathrm{IDM}}\le -1\,\mathrm{m/s^2}\)).

## 6. Limites / citations

Les fichiers `backend/app/data/markov/*.json` sont des **proxies calibrés littérature** (voir `CITATIONS.md`), **pas** une redistribution d’une base NDS propriétaire.

## 7. Fichiers code

- `backend/app/services/kinematic_solver.py`
- `backend/app/services/markov_noise.py`
- `backend/app/data/markov/`
- `frontend/src/lib/driverPresets.ts`, `paramDocs.ts`
