# Benchmark reference corpus — citations

CycleGen ships **engineering proxy seeds**, **full regulatory schedules**
(pinned CSV), and curated open GPS corpora (**VED**, **Microsoft GeoLife**).

## Proxy seeds (synthetic, short)

| ID | Intent | Notes |
|----|--------|-------|
| `wltc_class3_proxy` | Compact WLTC Class 3-like phases | Not UNECE official |
| `nedc_proxy` | Compact NEDC-like urban + EUDC | Not official NEDC |
| `demo_gps_richebourg_houdan` | Synthetic geo trace | Map-overlay UX only |

## Regulatory (family `regulatory`)

Rebuild / refresh:

```bash
python scripts/build_regulatory_cycles.py
```

| ID | Origin | Notes |
|----|--------|-------|
| `udds`, `ftp75`, `hwfet`, `us06` | **US EPA** 1 Hz dynamometer tables | Public EPA text schedules |
| `nedc` | EPA mirrors of UN/ECE ECE-15 ×4 + EUDC | Assembled Type I shape |
| `wltc_class1`, `wltc_class2`, `wltc_class3` | CycleGen reconstruction | Phase durations / peaks inspired by UNECE GTR No.15 — **not** official UNECE tables |

EPA schedules:
https://www.epa.gov/vehicle-and-fuel-emissions-testing/dynamometer-drive-schedules

Do **not** use unverified third-party GitHub mirrors that claim to be WLTC/FTP
but ship unrelated GPS (e.g. regional OBD dumps).

## VED — Vehicle Energy Dataset (real GPS + OBD)

| Field | Value |
|-------|--------|
| Upstream | https://github.com/gsoh/VED |
| License | Apache-2.0 |
| Paper | Oh, G.S., LeBlanc, D.J., Peng, H. IEEE T-ITS 2020. arXiv:1905.02081 |
| Region | Ann Arbor, Michigan, USA |
| Import | `python scripts/import_ved_trips.py --download --n 5` |

## Microsoft GeoLife (real GPS, labeled modes)

| Field | Value |
|-------|--------|
| Upstream / Kaggle | https://www.kaggle.com/datasets/arashnic/microsoft-geolife-gps-trajectory-dataset |
| Official | Microsoft Research Asia GeoLife Trajectories 1.3 |
| Download used | Figshare DOI [10.6084/m9.figshare.25577268](https://doi.org/10.6084/m9.figshare.25577268) (identical 1.3 zip; no Kaggle token required) |
| Papers | Zheng et al. WWW 2009; UbiComp 2008; IEEE Data Eng. Bull. 33(2) 2010 |
| Region | Mostly Beijing, China |
| Curated slice | Labeled **car** / **taxi** segments, ~10 min, 1 Hz; speed from successive haversine |
| Import | `python scripts/import_geolife_trips.py --download --n 5` |

Please cite Zheng et al. when publishing results that use GeoLife extracts.

## Renault — Grossglockner Route Planner (OEM)

| Field | Value |
|-------|--------|
| ID | `renault_grossglockner_route_planner` |
| Source file | `Velocity_Profile_Grossglockner_Route_Planner.xlsx` |
| Added | 2026-09-03 |
| Content | Official Renault velocity / accel / slope profile (~14.2 km, ~985 s) |
| Zones | **1st Part** `s ∈ [0, 1116)` m · **2nd Part** `s ∈ [1116, end)` m |
| Zone cut | Chosen so sheet average speeds (29.74 / 54.2 km/h) match ∫v dt segments |
| Notes | Velocity / accel / slope = Renault OEM. **No lat/lon** — dynamics / chart reference only (proprietary engineering data). |
| Vehicle (sheet) | Mass 2700 kg · Power 220 kW |

Zone driver limits (sheet *Summery*, Test):

| Zone | a_lon max | a_lon min | a_lat max |
|------|-----------|-----------|-----------|
| 1st Part | 2.5 | −3.6 | 3.15 |
| 2nd Part | 4.715 | −5.0 | 6.17 |

## Scientific disclaimer

- Comparing a French CycleGen A→B route to Ann Arbor (VED) or Beijing (GeoLife)
  via RMSE(v(t)) is a **dynamics / stop-structure** diagnostic, not a spatial twin.
- Regulatory cycles have **no lat/lon** — chart overlay only.
- WLTC reconstructions are for engineering diagnostics, not homologation claims.
- Prefer same-region GPS when validating map overlays.

Raw archives stay under `backend/app/data/benchmark_sources/` (gitignored).
