# CycleGen SUMO tooling

Templates and scripts for building a microscopic road network and ego `vType`
profiles (`Eco` / `Normal` / `Agressif`). The TraCI bridge (`sumo_bridge.py`) is
implemented separately (Agent F).

## Layout

```
sumo/
  templates/
    cyclegen.sumocfg   # simulation config (TraCI port 8813)
    vtypes.add.xml     # Eco / Normal / Agressif
    routes.rou.xml     # ego route stub
  scripts/
    prepare_network.py # OSM → network.net.xml + work dir
    healthcheck.sh     # sumo / netconvert / SUMO_HOME
```

## Prerequisites

- Docker (recommended), **or** host packages `sumo` + `sumo-tools`
- `SUMO_HOME` — Ubuntu packages: `/usr/share/sumo`
- Network access to Overpass when using `--bbox` (not needed with `--osm-file`)

If `netconvert` is missing on the host, `prepare_network.py` still writes the
correct workflow and exits with a clear error; run it inside the `sumo` image.

## Build the SUMO image

From the CycleGen repo root:

```bash
docker compose build sumo
docker compose up -d sumo
```

Healthcheck (compose already runs `which sumo`):

```bash
docker compose exec sumo bash /sumo/scripts/healthcheck.sh
```

## Enter the container

```bash
docker compose exec sumo bash
```

Inside the container:

- `SUMO_HOME=/usr/share/sumo`
- Templates mounted read-only at `/sumo`
- Writable work volume: `/tmp/cyclegen-sumo` (`sumo_work`)

## Prepare a network (Richebourg–Houdan bbox)

WGS84 bbox around Richebourg / Houdan (Yvelines):  
`south,west,north,east` = `48.78,1.58,48.84,1.66`

```bash
docker compose exec sumo python3 /sumo/scripts/prepare_network.py \
  --bbox 48.78,1.58,48.84,1.66 \
  --work-dir /tmp/cyclegen-sumo \
  --templates-dir /sumo/templates
```

One-shot without a long-running service:

```bash
docker compose run --rm sumo python3 /sumo/scripts/prepare_network.py \
  --bbox 48.78,1.58,48.84,1.66 \
  --work-dir /tmp/cyclegen-sumo \
  --templates-dir /sumo/templates
```

Outputs in the work dir:

| File | Role |
|------|------|
| `map.osm.xml` | Overpass (or copied) OSM extract |
| `network.net.xml` | `netconvert` result |
| `routes.rou.xml` | ego stub (`type=Normal`, empty edges) |
| `vtypes.add.xml` | Eco / Normal / Agressif |
| `cyclegen.sumocfg` | SUMO + TraCI remote-port `8813` |

### From a local OSM file

```bash
docker compose exec sumo python3 /sumo/scripts/prepare_network.py \
  --osm-file /tmp/cyclegen-sumo/map.osm.xml \
  --work-dir /tmp/cyclegen-sumo \
  --templates-dir /sumo/templates
```

### Host without SUMO

```bash
# Still validates CLI / download; fails clearly if netconvert absent:
python3 sumo/scripts/prepare_network.py \
  --bbox 48.78,1.58,48.84,1.66 \
  --work-dir /tmp/cyclegen-sumo \
  --templates-dir sumo/templates
# → ERROR: netconvert not found. Install SUMO … or use Docker …
```

Download OSM only (no convert):

```bash
python3 sumo/scripts/prepare_network.py \
  --bbox 48.78,1.58,48.84,1.66 \
  --work-dir /tmp/cyclegen-sumo \
  --templates-dir sumo/templates \
  --skip-netconvert
```

## Driving styles (`vType`)

| id | intent | accel | decel | speedFactor |
|----|--------|-------|-------|-------------|
| Eco | soft | 1.5 | 3.0 | 0.90 |
| Normal | default ego | 2.6 | 4.5 | 1.00 |
| Agressif | hard | 3.8 | 6.5 | 1.15 |

Switch ego style later via TraCI (`vehicle.setType`) or by rewriting
`routes.rou.xml` `type="…"`.

## Notes for Agent F (TraCI)

- Config exposes TraCI on port **8813** (`cyclegen.sumocfg`).
- Fill `ego_route` edges from the corridor / OSRM path after `network.net.xml` exists.
- Do not start a permanent TraCI listener in this service by default — compose keeps
  the image warm with `sleep infinity`; the API / bridge starts `sumo` per run.
