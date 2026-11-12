"""Bounded Overpass HTTP body before json.loads (G3)."""

from __future__ import annotations

import json
import unittest
from unittest.mock import MagicMock

import httpx

from app.services.data_fetcher import (
    OVERPASS_MAX_BYTES,
    OverpassResponseTooLargeError,
    SpatialDataAcquisition,
    _read_bounded_json,
)


class _FakeStreamResponse:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    def aiter_bytes(self, chunk_size: int = 65536):
        async def _gen():
            for piece in self._chunks:
                yield piece

        return _gen()


class TestReadBoundedJson(unittest.IsolatedAsyncioTestCase):
    async def test_parses_within_cap(self) -> None:
        body = json.dumps({"elements": []}).encode()
        resp = _FakeStreamResponse([body])
        data, nbytes = await _read_bounded_json(resp, OVERPASS_MAX_BYTES)
        self.assertEqual(data, {"elements": []})
        self.assertEqual(nbytes, len(body))

    async def test_raises_when_exceeding_cap(self) -> None:
        cap = 100
        chunk = b"x" * 60
        resp = _FakeStreamResponse([chunk, chunk])
        with self.assertRaises(OverpassResponseTooLargeError) as ctx:
            await _read_bounded_json(resp, cap)
        self.assertGreater(ctx.exception.received, cap)
        self.assertEqual(ctx.exception.cap, cap)


class TestOverpassRequestCap(unittest.IsolatedAsyncioTestCase):
    async def test_request_json_soft_fail_on_oversize(self) -> None:
        cap = 50
        big = b"{" + b'"x":' + b'"' + (b"y" * 200) + b'"}'
        stream_resp = _FakeStreamResponse([big])
        stream_resp.status_code = 200
        stream_resp.request = MagicMock()
        stream_resp.raise_for_status = MagicMock()

        class _StreamCtx:
            async def __aenter__(self):
                return stream_resp

            async def __aexit__(self, *args: object) -> None:
                return None

        client = MagicMock(spec=httpx.AsyncClient)
        client.stream = MagicMock(return_value=_StreamCtx())

        acq = SpatialDataAcquisition(client=client)
        out = await acq._request_json(
            "POST",
            "https://overpass.example/api/interpreter",
            data={"data": "[out:json];node;out;"},
            service="Overpass",
            soft_fail=True,
            max_response_bytes=cap,
        )
        self.assertEqual(out, {})
        client.stream.assert_called_once()


if __name__ == "__main__":
    unittest.main()
