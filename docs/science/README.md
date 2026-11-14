# CycleGen — Documentation scientifique

> Base de connaissance pour le volet d’aide latéral. Documentation technique de référence sur les modèles, hypothèses et limites implémentés dans CycleGen.

## Comment lire cette documentation

Chaque chapitre suit le même schéma :

1. **Pourquoi** — problème d’ingénierie en langage clair  
2. **Quoi** — définitions et symboles  
3. **Comment** — équations et règles implémentées dans CycleGen  
4. **Limites** — ce que le modèle **n’est pas**  
5. **Fichiers code** — où regarder dans le dépôt  

## Sommaire

| # | Document | Contenu |
|---|----------|---------|
| 00 | [Vue d’ensemble](00-vue-ensemble.md) | Objectif produit, pipeline, glossaire rapide |
| 01 | [Routage & trafic](01-routage-trafic.md) | Mapbox, OSRM, `depart_at`, `traffic_source` |
| 02 | [Cycle spatial](02-corridor-spatial.md) | \(S\), \(\alpha\), \(V_{legal}\), \(V_{traffic}\), \(V_{curve}\), \(V_{envelope}\) |
| 03 | [Feux & TLS](03-feux-tls.md) | Onde verte conditionnelle vs stochastique |
| 04 | [IDM & Markov](04-idm-markov.md) | Suivi de véhicule, bruit asymétrique, freinage critique |
| 05 | [Moteurs SUMO vs IDM](05-moteurs-sumo-idm.md) | Deux moteurs, fallback, parité paramétrique |
| 06 | [Benchmark & recalage](06-benchmark-recalage.md) | Corpus, KPIs, hints, injection / comparaison |
| 07 | [Limites & bonnes pratiques](07-limites-bonnes-pratiques.md) | Warnings, non-claims, usage scientifique |

## Message d’honnêteté scientifique (à retenir)

CycleGen produit des **cycles synthétiques physiquement contraints**, avec **traçabilité** (`traffic_source`, `warnings`, hints de recalage). Ce n’est **pas** :

- une vérité terrain absolue (NDS / GNSS mesurée),
- une homologation réglementaire (WLTP/NEDC officiels),
- un jumeau numérique d’un contrôleur de feux réel (SCATS/SCOOT).

Les seeds de benchmark et les TPM Markov sont des **proxies d’ingénierie** documentés — remplacez-les par des données autorisées pour un usage industriel critique.
