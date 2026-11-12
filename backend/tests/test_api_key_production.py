"""Production / require-flag API key fail-fast at app import."""

from __future__ import annotations

import importlib
import os
import sys
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient


def _drop_app_modules() -> None:
    for name in list(sys.modules):
        if name == "app.main" or name.startswith("app.api."):
            del sys.modules[name]


def _import_main(env: dict[str, str | None]) -> object:
    _drop_app_modules()
    for key in ("ENV", "CYCLEGEN_API_KEY", "CYCLEGEN_REQUIRE_API_KEY"):
        os.environ.pop(key, None)
    for key, value in env.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    with patch("dotenv.load_dotenv"):
        return importlib.import_module("app.main")


class TestApiKeyProduction(unittest.TestCase):
    def tearDown(self) -> None:
        _import_main({"ENV": "dev", "CYCLEGEN_API_KEY": None})

    def test_dev_without_key_imports(self) -> None:
        main = _import_main({"ENV": "dev", "CYCLEGEN_API_KEY": None})
        self.assertEqual(main._API_KEY, "")
        self.assertEqual(len(main.app.user_middleware), 1)

    def test_production_without_key_raises(self) -> None:
        with self.assertRaises(RuntimeError) as ctx:
            _import_main({"ENV": "production", "CYCLEGEN_API_KEY": None})
        self.assertIn("CYCLEGEN_API_KEY", str(ctx.exception))

    def test_prod_env_without_key_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            _import_main({"ENV": "prod", "CYCLEGEN_API_KEY": None})

    def test_require_flag_without_key_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            _import_main(
                {
                    "ENV": "dev",
                    "CYCLEGEN_REQUIRE_API_KEY": "1",
                    "CYCLEGEN_API_KEY": None,
                }
            )

    def test_production_with_key_registers_middleware(self) -> None:
        main = _import_main(
            {"ENV": "production", "CYCLEGEN_API_KEY": "test-secret-key"}
        )
        self.assertEqual(main._API_KEY, "test-secret-key")
        self.assertGreaterEqual(len(main.app.user_middleware), 2)

    def test_openapi_and_docs_require_key_when_configured(self) -> None:
        key = "test-secret-key"
        main = _import_main({"ENV": "dev", "CYCLEGEN_API_KEY": key})
        client = TestClient(main.app)
        self.assertEqual(client.get("/health").status_code, 200)
        for path in ("/docs", "/redoc", "/openapi.json"):
            self.assertEqual(client.get(path).status_code, 401, path)
            ok = client.get(path, headers={"X-API-Key": key})
            self.assertEqual(ok.status_code, 200, path)

    def test_http_query_api_key_rejected(self) -> None:
        key = "test-secret-key"
        main = _import_main({"ENV": "dev", "CYCLEGEN_API_KEY": key})
        client = TestClient(main.app)
        self.assertEqual(
            client.get(f"/openapi.json?api_key={key}").status_code, 401
        )
        self.assertEqual(
            client.get("/openapi.json", headers={"X-API-Key": key}).status_code,
            200,
        )

    def test_websocket_upgrade_may_use_query_api_key(self) -> None:
        key = "test-secret-key"
        main = _import_main({"ENV": "dev", "CYCLEGEN_API_KEY": key})
        client = TestClient(main.app)
        resp = client.get(
            f"/api/simulate/ws/nope?api_key={key}",
            headers={"Upgrade": "websocket", "Connection": "Upgrade"},
        )
        self.assertNotEqual(resp.status_code, 401)

    def test_websocket_upgrade_accepts_cg_ticket(self) -> None:
        import hashlib
        import hmac
        import time

        key = "test-secret-key"
        main = _import_main({"ENV": "dev", "CYCLEGEN_API_KEY": key})
        client = TestClient(main.app)
        ts = str(int(time.time()))
        sig = hmac.new(
            key.encode("utf-8"), ts.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        ticket = f"{ts}.{sig}"
        resp = client.get(
            f"/api/simulate/ws/nope?cg_ticket={ticket}",
            headers={"Upgrade": "websocket", "Connection": "Upgrade"},
        )
        self.assertNotEqual(resp.status_code, 401)

    def test_pack_summary_uses_basename_not_absolute_path(self) -> None:
        main = _import_main({"ENV": "dev", "CYCLEGEN_API_KEY": None})
        client = TestClient(main.app)
        resp = client.get("/api/calibrate/route-studio/pack")
        if resp.status_code != 200:
            self.skipTest("route_studio_fit_pack.json not present in test env")
        data = resp.json()
        self.assertNotIn("path", data)
        pack_file = data.get("pack_file")
        self.assertEqual(pack_file, "route_studio_fit_pack.json")
        self.assertIsNotNone(pack_file)
        assert pack_file is not None
        self.assertFalse(pack_file.startswith("/"))
        self.assertNotIn("..", pack_file)

    def test_n90_rejects_max_arms_above_runtime_cap(self) -> None:
        main = _import_main({"ENV": "dev", "CYCLEGEN_API_KEY": None})
        from app.api.routes_corridor import CORRIDOR_STORE

        client = TestClient(main.app)
        cid = "d4-n90-max-arms"
        self.assertTrue(CORRIDOR_STORE.try_put(cid, _tiny_corridor_for_n90()))
        try:
            resp = client.post(
                "/api/calibrate/n90",
                json={"corridor_id": cid, "reference_id": "avl_n90_bcb", "max_arms": 1024},
            )
            self.assertEqual(resp.status_code, 400)
            self.assertIn("128", resp.json()["detail"])
        finally:
            CORRIDOR_STORE.discard(cid)


def _tiny_corridor_for_n90():
    from app.models.schemas import LatLon, SpatialCorridor

    n = 5
    S = [float(i) * 10.0 for i in range(n)]
    V = [15.0] * n
    return SpatialCorridor(
        S=S,
        V_limite=V,
        alpha=[0.0] * n,
        S_feux=[],
        events=[],
        geometry=[LatLon(lat=0.0, lon=i * 0.0001) for i in range(n)],
    )


if __name__ == "__main__":
    unittest.main()
