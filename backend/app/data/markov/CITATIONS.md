# Markov TPM citations (CycleGen Vague 1)

## Format

Sparse JSON conditional distributions over residual accel `a_noise`:

- Key `"v_bin,a_bin"` — current state (`v_bin = floor(v / 10 m/s)`, `a_bin ∈ {-1,0,1}`)
- Value — map `{ "a_noise": probability, ... }` (row-stochastic)

Missing states → **null noise** (no crash). Critical braking / `a_IDM ≤ -1` → forced zero.

## Methodological anchors

1. **Balau et al., SAE 2015-01-0488** — Markov-chain synthesis of driving cycles.
2. **EVS30-style TPM practice** — discrete style-specific transition tables.

## Disclaimer

`eco.json` / `normal.json` / `agressif.json` are **literature-calibrated proxies**, not
redistributed NREL TSDC dumps. Replace with TPMs fit from authorised NDS for production.
