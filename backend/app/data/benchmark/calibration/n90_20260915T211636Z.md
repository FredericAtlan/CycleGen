# CycleGen calibration — AVL N90 (BSM→Albertville)

Generated: `2026-09-15T21:16:36.509647+00:00`
Reference: `avl_n90_bcb` · Corridor: `test-corridor` · Grid arms: **2**

## Recommended DriverPhysics

- driver_profile: `Normal`
- speed_factor : `1.050`
- a_max        : `2.400` m/s²
- b_comf       : `2.000` m/s²
- T (headway)  : `1.500` s
- T_h (scan)   : `4.000` s
- s0           : `2.000` m
- jerk_max     : `1.500` m/s³
- jerk_brake_max : `3.000` m/s³

## Top 5 arms

| Rank | Arm | RMSE_v | RMSE_a | ΔT% | Score |
|------|-----|--------|--------|-----|-------|
| 1 | `a2.40_b2.00_T1.50_Th4.0_s02.0_jm1.5_jb3.0_sf1.05` | 15.105 | 0.463 | -74.74 | 22.936 |
| 2 | `a1.60_b2.00_T1.50_Th4.0_s02.0_jm1.5_jb3.0_sf1.05` | 15.097 | 0.467 | -74.70 | 22.941 |

## Recette N90 (targets)

- RMSE_v ≤ 2.5 m/s
- RMSE_a ≤ 0.25 m/s²
- |ΔT_total| ≤ 3 %

