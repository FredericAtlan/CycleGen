# N90 fast parameter search

Generated: `2026-09-15T22:32:55.978957+00:00` · **34** arms (~2 min)

## Recommended DriverPhysics

```json
{
  "a_max": 2.0,
  "b_comf": 1.2,
  "T": 1.4,
  "T_h": 4.1,
  "s0": 2.5,
  "jerk_max": 1.5,
  "jerk_brake_max": 2.5,
  "speed_factor": 1.0
}
```

- RMSE_v: `2.0174` m/s (7.26 km/h) ✔ ≤ 2.5
- RMSE_a: `0.6715` m/s² ✘ ≤ 0.25
- ΔT: `-0.63` % ✔ |·| ≤ 3
- score: `4.7533` · note: `micro_seed`

## Top 10

| Rank | note | RMSE_v | RMSE_a | ΔT% | score | sf | a_max | b_comf |
|------|------|--------|--------|-----|-------|----|-------|--------|
| 1 | micro_seed | 2.017 | 0.671 | -0.63 | 4.753 | 1.000 | 2.000 | 1.200 |
| 2 | micro_seed | 2.042 | 0.669 | -0.51 | 4.758 | 1.000 | 1.850 | 1.200 |
| 3 | micro_seed | 2.019 | 0.677 | -0.63 | 4.776 | 1.000 | 2.150 | 1.200 |
| 4 | micro_seed | 2.166 | 0.695 | -0.12 | 4.957 | 1.000 | 1.850 | 1.350 |
| 5 | seed_from_long_search | 2.153 | 0.707 | -0.20 | 4.994 | 1.000 | 2.000 | 1.350 |
| 6 | micro_seed | 2.116 | 0.718 | -0.27 | 5.009 | 1.000 | 2.150 | 1.350 |
| 7 | seed_T16 | 2.162 | 0.710 | -0.16 | 5.014 | 1.000 | 2.000 | 1.350 |
| 8 | seed_T12 | 2.159 | 0.712 | -0.20 | 5.022 | 1.000 | 2.000 | 1.350 |
| 9 | seed_bcb_jerk | 2.342 | 0.683 | +0.43 | 5.109 | 1.000 | 2.000 | 1.350 |
| 10 | refine_log_best2 | 2.287 | 0.725 | +0.23 | 5.205 | 1.000 | 1.850 | 1.500 |

## Files to verify

- `n90_fast_search_20260915T222507Z.csv` — tous les bras
- `n90_fast_search_20260915T222507Z.json` — rapport complet
- `latest_n90_recommended.json` — params à coller dans l’UI
- `latest_n90_iter.csv` — alias latest

