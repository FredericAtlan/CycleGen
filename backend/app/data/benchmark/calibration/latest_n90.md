# CycleGen calibration — AVL N90 (BSM→Albertville)

Generated: `2026-09-25T20:54:10.626339+00:00`
Reference: `avl_n90_bcb` · Corridor: `test-corridor` · Grid arms: **2**

## Recommended DriverPhysics

- driver_profile: `Normal`
- speed_factor : `1.050`
- a_max        : `1.600` m/s²
- b_comf       : `2.000` m/s²
- T (headway)  : `1.500` s
- T_h (scan)   : `4.000` s
- s0           : `2.000` m
- jerk_max     : `1.500` m/s³
- jerk_brake_max : `3.000` m/s³

## Top 5 arms

| Rank | Arm | RMSE_v | RMSE_a | ΔT% | Score |
|------|-----|--------|--------|-----|-------|
| 1 | `a1.60_b2.00_T1.50_Th4.0_s02.0_jm1.5_jb3.0_sf1.05` | 8.543 | 0.955 | -97.18 | 20.139 |
| 2 | `a2.40_b2.00_T1.50_Th4.0_s02.0_jm1.5_jb3.0_sf1.05` | 8.829 | 1.130 | -97.22 | 21.126 |

## Recette N90 (targets)

- RMSE_v ≤ 2.5 m/s
- RMSE_a ≤ 0.25 m/s²
- |ΔT_total| ≤ 3 %

