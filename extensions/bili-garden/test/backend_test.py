"""Offline contract tests: real SDK imports, no DSH/MCP runtime or network."""
import asyncio
import builtins
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
_original_import = builtins.__import__
def host_only_import(name, *args, **kwargs):
    if name.split(".")[0] in {"mcp", "dsh"}:
        raise AssertionError("External host imported: " + name)
    return _original_import(name, *args, **kwargs)
builtins.__import__ = host_only_import
import bridge
import bilibili_backend as backend

class BackendTests(unittest.IsolatedAsyncioTestCase):
    def request(self, name, **args):
        return {"name": name, "args": args, "credential": {"sessdata": "fixture", "bili_jct": "fixture"}}

    async def test_native_import_and_disallowed_legacy_entries(self):
        for name in ("bili_setting_set", "bili_report_save", "bili_login", "bili_send_dynamic"):
            with self.assertRaisesRegex(ValueError, "允许"):
                await bridge.dispatch(self.request(name))
        self.assertNotIn("mcp", sys.modules)

    async def test_credential_cleared_after_success_and_failure(self):
        async def inspect(**args):
            self.assertEqual(backend.get_cred().sessdata, "fixture")
            return json.dumps({"ok": True})
        with patch.object(backend, "bili_search", inspect):
            self.assertTrue((await bridge.dispatch(self.request("bili_search", keyword="a")))["ok"])
        self.assertIsNone(backend.credential_context.get())
        with patch.object(backend, "bili_search", AsyncMock(side_effect=RuntimeError("fixture"))):
            with self.assertRaises(RuntimeError):
                await bridge.dispatch(self.request("bili_search", keyword="a"))
        self.assertIsNone(backend.credential_context.get())

    async def test_concurrent_credentials_are_isolated(self):
        async def inspect(**args):
            before = backend.get_cred().sessdata
            await asyncio.sleep(0.01)
            self.assertEqual(before, backend.get_cred().sessdata)
            return {"owner": before}
        first = self.request("bili_search", keyword="a")
        second = self.request("bili_search", keyword="b")
        second["credential"]["sessdata"] = "second"
        with patch.object(backend, "bili_search", inspect):
            results = await asyncio.gather(bridge.dispatch(first), bridge.dispatch(second))
        self.assertEqual([r["owner"] for r in results], ["fixture", "second"])

    async def test_reply_retains_receipt_and_root(self):
        video = MagicMock()
        video.get_info = AsyncMock(return_value={"aid": 42})
        send = AsyncMock(return_value={"rpid": 123, "root": 11, "parent": 12})
        with patch.object(backend.video, "Video", return_value=video), patch.object(backend, "_comment_state", AsyncMock(return_value="live")), patch.object(backend.comment, "send_comment", send):
            result = await bridge.dispatch(self.request("bili_reply", bvid="BV1JcnW6pEFT", text="fixture", rpid="12", root="11"))
        self.assertEqual(result["rpid"], 123)
        self.assertEqual(send.call_args.kwargs["root"], 11)
        self.assertEqual(send.call_args.kwargs["parent"], 12)

    async def test_deleted_comment_never_sends(self):
        video = MagicMock()
        video.get_info = AsyncMock(return_value={"aid": 42})
        send = AsyncMock()
        with patch.object(backend.video, "Video", return_value=video), patch.object(backend, "_comment_state", AsyncMock(return_value="gone")), patch.object(backend.comment, "send_comment", send):
            result = await bridge.dispatch(self.request("bili_reply", bvid="BV1JcnW6pEFT", text="fixture", rpid=12))
        self.assertFalse(result["success"])
        send.assert_not_called()

    async def test_guard_failure_preserves_cursor(self):
        with patch.object(backend.session, "get_at", AsyncMock(side_effect=RuntimeError("offline"))):
            result = await bridge.dispatch(self.request("bili_guard_scan", since_at_id=12, since_at_time=34))
        self.assertEqual(result["at_cursor"], {"id": 12, "time": 34})
        self.assertTrue(result["errors"])

if __name__ == "__main__":
    unittest.main()
