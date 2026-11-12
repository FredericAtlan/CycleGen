"""Unit tests for rs_fingerprint pure service."""

from __future__ import annotations

import io
import math
import unittest

from pydantic import ValidationError

from app.api.routes_drivers import AggregateBody, AggregateItem, SeriesFingerprintBody
from app.services.rs_fingerprint import (
    _MAX_PROFILE_POINTS,
    _MAX_ROWS_SCANNED,
    _clamp,
    aggregate_fingerprints,
    fingerprint_payload,
    fingerprint_series,
    parse_series_csv,
    suggest_physics,
)


class TestRsFingerprint(unittest.TestCase):
    def test_series_fingerprint_body_rejects_oversized_series(self) -> None:
        n = _MAX_PROFILE_POINTS + 1
        with self.assertRaises(ValidationError):
            SeriesFingerprintBody(t=[0.0] * n, v=[1.0] * n)

    def test_aggregate_body_rejects_too_many_items(self) -> None:
        item = {"style": "prudent", "fingerprint": {"a_pos_p85": 1.0}}
        with self.assertRaises(ValidationError):
            AggregateBody(items=[item] * 33)

    def test_clamp_nan_uses_fallback_not_hi(self) -> None:
        self.assertEqual(_clamp(float("nan"), 0.6, 7.5, fallback=2.0), 2.0)
        self.assertEqual(_clamp(float("inf"), 0.6, 7.5, fallback=2.0), 2.0)

    def test_suggest_physics_flat_velocity_neutral_profile(self) -> None:
        fp = fingerprint_series([0.0, 1.0, 2.0], [1.0, 1.0, 1.0])
        phys = suggest_physics(fp)
        self.assertEqual(phys.a_max, 2.0)
        self.assertEqual(phys.base_profile, "Normal")

    def test_fingerprint_payload_rejects_oversized_parsed_series(self) -> None:
        n = _MAX_PROFILE_POINTS + 1
        with self.assertRaises(ValueError) as ctx:
            fingerprint_payload(
                series={"t": list(range(n)), "v": [1.0] * n},
            )
        self.assertIn("points; max", str(ctx.exception))

    def test_csv_parse_aborts_before_max_plus_one(self) -> None:
        lines = ["t,v"] + [f"{i},1.0" for i in range(_MAX_PROFILE_POINTS + 1)]
        with self.assertRaises(ValueError) as ctx:
            parse_series_csv("\n".join(lines))
        self.assertIn("points; max", str(ctx.exception))

    def test_csv_aborts_on_row_scan_budget_invalid_rows(self) -> None:
        lines = ["t,v"] + ["bad,not_a_number"] * (_MAX_ROWS_SCANNED + 1)
        with self.assertRaises(ValueError) as ctx:
            parse_series_csv("\n".join(lines))
        self.assertIn("row scan budget", str(ctx.exception))

    def test_json_upload_aborts_on_oversized_arrays(self) -> None:
        import json

        n = _MAX_PROFILE_POINTS + 1
        payload = json.dumps({"t": list(range(n)), "v": [1.0] * n}).encode()
        with self.assertRaises(ValueError) as ctx:
            fingerprint_payload(raw=payload, filename="trace.json")
        self.assertIn("points; max", str(ctx.exception))

    def test_aggregate_item_rejects_non_numeric_fingerprint(self) -> None:
        with self.assertRaises(ValidationError):
            AggregateItem(style="prudent", fingerprint={"a_pos_p85": "fast"})

    def test_aggregate_item_rejects_unknown_fingerprint_keys(self) -> None:
        with self.assertRaises(ValidationError):
            AggregateItem(style="prudent", fingerprint={"not_a_metric": 1.0})

    def test_aggregate_fingerprints_non_numeric_raises_value_error(self) -> None:
        with self.assertRaises(ValueError):
            aggregate_fingerprints(
                [{"style": "prudent", "fingerprint": {"a_pos_p85": "x"}}]
            )

    def test_fingerprint_series_basic(self) -> None:
        t = [i * 0.1 for i in range(200)]
        v = [8.0 + (i % 20) * 0.05 for i in range(200)]
        fp = fingerprint_series(t, v)
        self.assertEqual(fp.n, 200)
        self.assertGreater(fp.duration_s, 0)
        self.assertTrue(math.isfinite(fp.a_pos_p85))
        phys = suggest_physics(fp)
        self.assertEqual(phys.pedal_tau_s, 0.0)
        self.assertEqual(phys.vdes_tau_s, 0.0)
        self.assertEqual(phys.descent_hold_gain, 0.0)
        self.assertGreaterEqual(phys.a_max, 0.6)
        self.assertLessEqual(phys.a_max, 7.5)

    def test_fingerprint_csv_sha256(self) -> None:
        rows = ["temps [s],velocity [m/s]"]
        for i in range(50):
            rows.append(f"{i * 0.2},{10 + 0.1 * i}")
        raw = "\n".join(rows).encode()
        out = fingerprint_payload(raw=raw, filename="demo.csv")
        self.assertTrue(out["source_sha256"])
        self.assertEqual(len(out["source_sha256"]), 64)
        self.assertIn("pedal_tau_s", out["physics"])
        self.assertGreaterEqual(out["physics"]["pedal_tau_s"], 0.0)
        self.assertLessEqual(out["physics"]["pedal_tau_s"], 10.0)
        self.assertIn("source_profile", out)
        self.assertIn("time", out["source_profile"])
        self.assertIn("velocity_mps", out["source_profile"])
        self.assertGreaterEqual(len(out["source_profile"]["time"]), 2)
        self.assertEqual(
            len(out["source_profile"]["time"]),
            len(out["source_profile"]["velocity_mps"]),
        )
        self.assertGreaterEqual(out["n_points"], 40)

    def test_preview_and_fingerprint_prea_like_xlsx(self) -> None:
        from openpyxl import Workbook

        from app.services.rs_fingerprint import preview_table_bytes

        wb = Workbook()
        sh = wb.active
        sh.append(["Temps", "Vitesse sp", "Vitesse realized", "Pente"])
        sh.append(["s", "kph", "kph", "%"])
        for i in range(40):
            t = i * 0.1
            sh.append([t, 10.0 + i * 0.2, 9.5 + i * 0.18, -2.0])
        buf = io.BytesIO()
        wb.save(buf)
        raw = buf.getvalue()

        prev = preview_table_bytes(raw, "Grossglokner_RS_PreA.xlsx")
        self.assertEqual(prev["headers"][0], "Temps")
        self.assertEqual(prev["suggested"]["col_t"], 0)
        self.assertEqual(prev["suggested"]["col_v"], 2)
        self.assertEqual(prev["suggested"]["v_unit"], "kmh")
        self.assertEqual(prev["units"], ["s", "kph", "kph", "%"])
        self.assertGreaterEqual(prev["n_data_rows"], 40)

        out_auto = fingerprint_payload(
            raw=raw, filename="Grossglokner_RS_PreA.xlsx"
        )
        self.assertGreaterEqual(out_auto["n_points"], 40)
        # realized ~9.5 kph → mean ≈ mean of series
        self.assertAlmostEqual(
            out_auto["fingerprint"]["v_mean_mps"] * 3.6,
            sum(9.5 + i * 0.18 for i in range(40)) / 40,
            delta=0.5,
        )

        # explicit: use setpoint column instead
        out_sp = fingerprint_payload(
            raw=raw,
            filename="Grossglokner_RS_PreA.xlsx",
            col_t=0,
            col_v=1,
            v_unit="kmh",
        )
        self.assertGreater(
            out_sp["fingerprint"]["v_mean_mps"],
            out_auto["fingerprint"]["v_mean_mps"],
        )

    def test_aggregate_prudent_dynamique(self) -> None:
        base = fingerprint_series(
            [i * 0.1 for i in range(100)],
            [5.0 + 0.02 * i for i in range(100)],
        )
        soft = fingerprint_series(
            [i * 0.1 for i in range(100)],
            [4.0 + 0.01 * i for i in range(100)],
        )
        pack = aggregate_fingerprints(
            [
                {"style": "prudent", "fingerprint": soft.__dict__},
                {"style": "dynamique", "fingerprint": base.__dict__},
            ]
        )
        self.assertEqual(pack["prudent"]["n"], 1)
        self.assertEqual(pack["dynamique"]["n"], 1)
        self.assertEqual(pack["prudent"]["physics"]["pedal_tau_s"], 0.0)


if __name__ == "__main__":
    unittest.main()
