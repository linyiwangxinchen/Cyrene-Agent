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

    def mention(self, ident, at_time, **item):
        return {"id": ident, "at_time": at_time, "user": {"mid": 456, "nickname": "用户"},
                "item": {"type": "reply", "business_id": 1, "subject_id": 170001,
                         "source_id": ident + 1000, "root_id": 0,
                         "uri": "https://www.bilibili.com/video/BV17x411w7KC", "source_content": "@昔涟 你怎么看？", **item}}

    async def test_guard_checks_latest_page_instead_of_using_watermark_as_page_cursor(self):
        at = AsyncMock(return_value={"items": [self.mention(110, 110), self.mention(90, 90)],
                                    "cursor": {"id": 90, "time": 90, "is_end": True}})
        with patch.object(backend.session, "get_at", at):
            first = await bridge.dispatch(self.request("bili_guard_scan", since_at_id=100, since_at_time=100))
            self.assertIsNone(at.call_args.kwargs.get("last_id"))
            self.assertIsNone(at.call_args.kwargs.get("at_time"))
            self.assertEqual([it["id"] for it in first["at"]], [110])
            self.assertEqual(first["at_cursor"], {"id": 110, "time": 110})
            at.return_value = {"items": [self.mention(120, 120), self.mention(110, 110)],
                               "cursor": {"id": 110, "time": 110, "is_end": True}}
            second = await bridge.dispatch(self.request("bili_guard_scan", since_at_id=110, since_at_time=110))
        self.assertIn(120, [it["id"] for it in second["at"]])

    async def test_guard_resolves_av_link_and_does_not_treat_dynamic_as_video_reply(self):
        at = AsyncMock(return_value={"items": [
            self.mention(10, 10, uri="https://www.bilibili.com/video/av170001", root_id=999),
            self.mention(11, 11, business_id=17, type="dynamic"),
        ], "cursor": {"is_end": True}})
        with patch.object(backend.session, "get_at", at):
            result = await bridge.dispatch(self.request("bili_guard_scan"))
        self.assertEqual(len(result["at"]), 1)
        self.assertEqual(result["at"][0]["bvid"], "BV17x411w7KC")
        self.assertEqual(result["at"][0]["root_id"], 999)

    async def test_guard_backlog_resumes_after_restart_without_skipping_unread_pages(self):
        at = AsyncMock(side_effect=[
            {"items": [self.mention(30, 30)], "cursor": {"id": 30, "time": 30, "is_end": False}},
            {"items": [self.mention(20, 20), self.mention(10, 10)], "cursor": {"id": 10, "time": 10, "is_end": True}},
        ])
        with patch.object(backend.session, "get_at", at):
            first = await bridge.dispatch(self.request("bili_guard_scan", since_at_id=10, since_at_time=10, max_pages=1))
            self.assertEqual(first["at_cursor"], {"id": 10, "time": 10})
            self.assertEqual(first["at_resume"]["id"], 30)
            second = await bridge.dispatch(self.request("bili_guard_scan", since_at_id=10, since_at_time=10,
                                                       at_resume=first["at_resume"], max_pages=1))
        self.assertEqual(at.call_args.kwargs["last_id"], 30)
        self.assertIn(20, [it["id"] for it in second["at"]])
        self.assertEqual(second["at_cursor"], {"id": 30, "time": 30})
        self.assertIsNone(second["at_resume"])

    async def test_guard_partial_page_failure_keeps_progress_and_retries_missing_page(self):
        at = AsyncMock(side_effect=[
            {"items": [self.mention(120, 120)], "cursor": {"id": 120, "time": 120, "is_end": False}},
            RuntimeError("offline"),
            {"items": [self.mention(110, 110), self.mention(90, 90)], "cursor": {"id": 90, "time": 90, "is_end": True}},
        ])
        with patch.object(backend.session, "get_at", at):
            first = await bridge.dispatch(self.request("bili_guard_scan", since_at_id=100, since_at_time=100))
            self.assertEqual(first["at_cursor"], {"id": 100, "time": 100})
            self.assertEqual(first["at_resume"]["id"], 120)
            self.assertTrue(first["errors"])
            second = await bridge.dispatch(self.request("bili_guard_scan", since_at_id=100, since_at_time=100, at_resume=first["at_resume"]))
        self.assertEqual(second["at_cursor"], {"id": 120, "time": 120})
        self.assertEqual([item["id"] for item in second["at"]], [110])

    async def test_guard_same_second_mentions_on_next_page_are_not_dropped(self):
        at = AsyncMock(side_effect=[
            {"items": [self.mention(100, 100)], "cursor": {"id": 100, "time": 100, "is_end": False}},
            {"items": [self.mention(90, 100), self.mention(80, 99)], "cursor": {"id": 80, "time": 99, "is_end": True}},
        ])
        with patch.object(backend.session, "get_at", at):
            result = await bridge.dispatch(self.request("bili_guard_scan", since_at_id=100, since_at_time=100))
        self.assertEqual([item["id"] for item in result["at"]], [100, 90])

if __name__ == "__main__":
    unittest.main()
