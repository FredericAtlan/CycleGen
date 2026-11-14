# CycleGen GPS corpus calibration

Generated: `2026-09-02T23:22:30.316317+00:00`
Sources: **10** · Grid arms: **23**

## Recommended average parameters

- **driver_profile**: `Normal`
- **tls_override**: `auto`
- **speed_factor**: `0.938`
- **a_max**: `2.046` m/s²
- **b_comf**: `3.772` m/s²
- **feux_keep** (TLS density vs OSM): `1.058`
- Mean best RMSE_v: `8.1519` m/s
- Mean best score: `13.3622`

## Per-source best arms

| Source | Profile | TLS | sf | a_max | feux | score | RMSE | ΔT% |
|--------|---------|-----|----|-------|------|-------|------|-----|
| `ved_veh202_trip1202` | Eco | green_wave | 0.9 | 1.5 | 1.0 | 18.779 | 9.97 | +111.9 |
| `ved_veh250_trip1329` | Normal | green_wave | 1.1 | 3.0 | 1.0 | 13.549 | 7.98 | +107.8 |
| `ved_veh497_trip462` | Eco | auto | 0.85 | 1.3 | 1.0 | 12.734 | 7.49 | +51.9 |
| `ved_veh540_trip559` | Normal | auto | 1.0 | 2.6 | 0.5 | 11.203 | 7.64 | +5.3 |
| `ved_veh579_trip169` | Normal | green_wave | 1.0 | 2.6 | 1.0 | 24.144 | 13.24 | +57.5 |
| `geolife_u010_taxi_20080620_1302` | Eco | green_wave | 0.85 | 1.3 | 1.0 | 10.853 | 7.35 | +24.7 |
| `geolife_u062_car_20080716_0238` | Normal | auto | 0.9 | 2.2 | 1.0 | 13.135 | 7.75 | -45.3 |
| `geolife_u125_car_20080909_1402` | Normal | auto | 1.0 | 2.6 | 1.5 | 11.052 | 7.94 | +8.4 |
| `geolife_u128_car_20090128_0152` | Eco | auto | 0.85 | 1.3 | 1.0 | 7.473 | 4.86 | +30.0 |
| `geolife_u153_taxi_20080516_1330` | Normal | auto | 1.0 | 2.6 | 1.5 | 10.701 | 7.28 | +1.7 |

## How to apply in UI

1. Driver preset closest to recommended `driver_profile`.
2. Override physics: `a_max`, `b_comf`, `speed_factor`.
3. TLS mode: recommended `tls_override` (Scénarios D / editor).
4. If `feux_keep` ≠ 1, thin/densify lights in the TLS editor before Simulate.

