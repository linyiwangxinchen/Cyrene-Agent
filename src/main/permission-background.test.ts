import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({ root: "", send: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => state.root },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: state.send } }] },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("./logger", () => ({ logger: { info: vi.fn() }, LogTag: { Permission: "permission" } }));
vi.mock("./toast/toast-events", () => ({ toastEvents: { publishApprovalPending: vi.fn(), publishApprovalSettled: vi.fn() } }));
import { cancelPendingApprovalsForRun, checkPermission, setCurrentLevel, registerPermissionIpc } from "./permission";
import { getRelationshipStore } from "./relationship/relationship-log";
import { IPC } from "../shared/ipc-channels";

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "permission-background-"));
  setCurrentLevel("per-action");
  state.send.mockClear();
});
afterEach(() => {
  cancelPendingApprovalsForRun("foreground");
  setCurrentLevel("read-only");
  rmSync(state.root, { recursive: true, force: true });
});

it.each(["fs-read", "fs-write", "shell", "network"] as const)("denies background %s without publishing an approval to another open conversation", async risk => {
  const result = await checkPermission({ toolId: "fixture", toolName: "fixture", toolDescription: "fixture", args: {}, risk, runId: "background", allowPrompt: false });
  expect(result.allowed).toBe(false);
  expect(state.send).not.toHaveBeenCalled();
});

it("keeps automatically allowed tools available and foreground approval unchanged", async () => {
  const input = { toolId: "fixture", toolName: "fixture", toolDescription: "fixture", args: {}, risk: "safe" as const };
  expect((await checkPermission({ ...input, allowPrompt: false })).allowed).toBe(true);
  expect(state.send).not.toHaveBeenCalled();
  const pending = checkPermission({ ...input, risk: "fs-write", runId: "foreground" });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(state.send).toHaveBeenCalled();
  cancelPendingApprovalsForRun("foreground");
  await rejected;
});

it("preserves full permission mode for background tools without requesting approval", async () => {
  setCurrentLevel("full");
  expect((await checkPermission({ toolId: "fixture", toolName: "fixture", toolDescription: "fixture", args: {}, risk: "shell", allowPrompt: false })).allowed).toBe(true);
  expect(state.send).not.toHaveBeenCalled();
});

it("enforces a companion pause even when the harness bypasses the base approval policy", async () => {
  const store = getRelationshipStore();
  await store.command({ type: "permissions", expectedRevision: 1, patch: { paused: true } });
  const result = await checkPermission({ toolId: "fixture", toolName: "fixture", toolDescription: "fixture", args: {}, risk: "safe", effect: "read", bypassBasePolicy: true });
  expect(result.allowed).toBe(false);
  expect(state.send).not.toHaveBeenCalled();
});

it("allows an explicitly headless channel to skip companion ask rules without publishing approval", async () => {
  const store = getRelationshipStore();
  await store.command({ type: "permissions", expectedRevision: 1, patch: { preset: "full", confirmTools: ["fixture"] } });
  const result = await checkPermission({
    toolId: "fixture", toolName: "fixture", toolDescription: "fixture", args: {},
    risk: "shell", effect: "mutation", allowPrompt: false,
    bypassBasePolicy: true, bypassCompanionApproval: true,
  });
  expect(result.allowed).toBe(true);
  expect(state.send).not.toHaveBeenCalled();
});

it.each([
  { patch: {}, allowed: true, draft: false },
  { patch: { confirmTools: ["fixture"] }, allowed: false, draft: true },
  { patch: { deniedTools: ["fixture"], confirmTools: ["fixture"] }, allowed: false, draft: false },
  { patch: { paused: true }, allowed: false, draft: false },
  { patch: { preset: "basic" as const }, allowed: false, draft: false },
])("honors explicit controls for configured background replies: $patch", async ({ patch, allowed, draft }) => {
  await getRelationshipStore().command({ type: "permissions", expectedRevision: 1, patch: { preset: "full", ...patch } });
  const result = await checkPermission({ toolId: "fixture", toolName: "fixture", toolDescription: "fixture", args: {},
    risk: "fs-write", effect: "mutation", allowPrompt: false, bypassBasePolicy: true, bypassCompanionApproval: "preset" });
  expect(result.allowed).toBe(allowed);
  expect(Boolean(result.needsApproval)).toBe(draft);
  expect(state.send).not.toHaveBeenCalled();
});

it("rejects an approved call if its authorization was revoked while the card was open", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  registerPermissionIpc({ handle: (name, fn) => { handlers.set(name, fn); }, on() {}, dispose() {}, removeHandler() {} });
  const pending = checkPermission({ toolId: "fixture", toolName: "fixture", toolDescription: "fixture", args: {}, risk: "fs-write", effect: "mutation", runId: "foreground" });
  const request = state.send.mock.calls.find(([name]) => name === IPC.PERMISSION_APPROVAL_REQUEST)![1];
  const store = getRelationshipStore();
  await store.command({ type: "permissions", expectedRevision: 1, patch: { deniedTools: ["fixture"] } });
  handlers.get(IPC.PERMISSION_APPROVAL_RESOLVE)!({}, { id: request.id, allowed: true });
  expect(await pending).toMatchObject({ allowed: false, reason: "等待审批期间能力授权已撤回。" });
});

it("requireApproval asks even at full level and under allow_all channel bypass", async () => {
  setCurrentLevel("full");
  const input = { toolId: "skill_write", toolName: "写入 Skill", toolDescription: "fixture", args: {}, risk: "fs-write" as const, effect: "mutation" as const, requireApproval: true };
  // 渠道后台：allow_all + bypassCompanionApproval + 无交互界面 → 拒绝，不发审批卡
  const headless = await checkPermission({ ...input, allowPrompt: false, bypassBasePolicy: true, bypassCompanionApproval: true });
  expect(headless.allowed).toBe(false);
  expect(state.send).not.toHaveBeenCalled();
  // 前台：即使是完全访问档位，也要弹审批卡
  const pending = checkPermission({ ...input, runId: "foreground" });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(state.send.mock.calls.some(([name]) => name === IPC.PERMISSION_APPROVAL_REQUEST)).toBe(true);
  cancelPendingApprovalsForRun("foreground");
  await rejected;
});

it("requireApproval does not lift a read-only denial", async () => {
  setCurrentLevel("read-only");
  const result = await checkPermission({ toolId: "skill_install", toolName: "安装 Skill", toolDescription: "fixture", args: {}, risk: "fs-write", effect: "mutation", requireApproval: true });
  expect(result.allowed).toBe(false);
  expect(state.send).not.toHaveBeenCalled();
});
