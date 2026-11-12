"""Bounded read for POST /drivers/fingerprint multipart uploads."""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock

from fastapi import HTTPException, UploadFile

from app.api.routes_drivers import (
    _MAX_UPLOAD_BYTES,
    _UPLOAD_CHUNK_BYTES,
    _parse_content_length,
    _read_bounded_upload,
)


class TestFingerprintUploadCap(unittest.TestCase):
    def test_parse_content_length(self) -> None:
        self.assertIsNone(_parse_content_length(None))
        self.assertIsNone(_parse_content_length("not-a-number"))
        self.assertIsNone(_parse_content_length("-1"))
        self.assertEqual(_parse_content_length("123"), 123)

    def test_content_length_over_cap_raises_without_read(self) -> None:
        file = MagicMock(spec=UploadFile)
        file.read = AsyncMock()
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                _read_bounded_upload(
                    file, content_length=_MAX_UPLOAD_BYTES + 1
                )
            )
        self.assertEqual(ctx.exception.status_code, 413)
        file.read.assert_not_called()

    def test_chunked_read_aborts_when_exceeding_cap(self) -> None:
        chunk = b"x" * _UPLOAD_CHUNK_BYTES
        file = MagicMock(spec=UploadFile)
        file.read = AsyncMock(side_effect=[chunk] * 41 + [b""])
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(_read_bounded_upload(file, content_length=None))
        self.assertEqual(ctx.exception.status_code, 413)
        self.assertLessEqual(file.read.await_count, 41)

    def test_read_within_cap_succeeds(self) -> None:
        data = b"hello,fingerprint\n"
        file = MagicMock(spec=UploadFile)
        file.read = AsyncMock(side_effect=[data, b""])
        out = asyncio.run(
            _read_bounded_upload(file, content_length=len(data))
        )
        self.assertEqual(out, data)


if __name__ == "__main__":
    unittest.main()
