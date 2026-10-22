// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfigView } from "../../../settings/shared/types";
import { McpSettingsPanel } from "./McpSettingsPanel";

// 保留真实设置面板、Ant Design 控件和 DOM 事件，只隔离翻译、图标及 IPC。
vi.mock("../../i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@lobehub/icons", () => ({ MCP: () => null }));

const addMcpServer = vi.fn(async (_config: McpServerConfigView): Promise<{
  ok: boolean; toolIds?: string[]; error?: string;
}> => ({ ok: true, toolIds: [] }));
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  })));
  vi.stubGlobal("settings", {
    listMcpServerConfigs: vi.fn(async () => []),
    listMcpServers: vi.fn(async () => []),
    getGeneral: vi.fn(async () => ({})),
    addMcpServer,
  });
  addMcpServer.mockReset();
  addMcpServer.mockResolvedValue({ ok: true, toolIds: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function clickControl(key: string) {
  // Modal 挂在 document.body 的 Portal 中；从真实控件触发切换及提交。
  const control = [...document.querySelectorAll<HTMLElement>("button, label")]
    .find((node) => node.textContent === `settingsPage.mcp.${key}`);
  expect(control, `找不到 MCP 控件：${key}`).toBeDefined();
  await act(async () => control!.click());
}

async function setText(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(input, `找不到输入框：${id}`).not.toBeNull();
  const prototype = input!.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openJson(args: unknown[]) {
  await act(async () => root.render(createElement(McpSettingsPanel)));
  await clickControl("addServer");
  await clickControl("jsonMode");
  await setText("cy-mcp-json", JSON.stringify({
    mcpServers: { demo: { command: "node", args, env: { EXAMPLE_ONLY: "unchanged" } } },
  }));
}

function expectSubmittedArgs(args: string[]) {
  expect(addMcpServer).toHaveBeenCalledExactlyOnceWith({
    id: "demo", name: "demo", transport: "stdio", command: "node", args,
    env: { EXAMPLE_ONLY: "unchanged" },
  });
}

describe("MCP 参数在模式切换和提交时保留边界", () => {
  const args = [
    "C:\\My Folder\\server.js",
    "--label",
    "hello world",
    'say "hello"',
    "C:\\tools\\",
    "",
    "first\\nsecond",
    "left\\tright",
  ];

  it("反复切换 JSON → 表单 → JSON 后参数及其他字段保持不变", async () => {
    await openJson(args);

    for (let round = 0; round < 3; round++) {
      await clickControl("formMode");
      await clickControl("jsonMode");
      const json = document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")!.value;
      expect(JSON.parse(json)).toEqual({
        mcpServers: { demo: { command: "node", args, env: { EXAMPLE_ONLY: "unchanged" } } },
      });
    }
    expect(addMcpServer).not.toHaveBeenCalled();
  });

  it("从 JSON 切到表单后确认，将原始参数数组完整交给 IPC", async () => {
    await openJson(args);
    await clickControl("formMode");
    await clickControl("confirm");

    expectSubmittedArgs(args);
  });

  it("直接在 JSON 模式确认，同样保留空参数和特殊字符", async () => {
    await openJson(args);
    await clickControl("confirm");

    expectSubmittedArgs(args);
  });

  it.each([
    { source: "json", switchModes: false },
    { source: "form", switchModes: false },
    { source: "json", switchModes: true },
    { source: "form", switchModes: true },
  ] as const)("数字和布尔参数从 $source 输入、切换=$switchModes 时保留草稿并在添加时转成字符串", async ({ source, switchModes }) => {
    const mixedArgs = ["--port", 3000, true, false, 0, ...args];
    await openJson(source === "json" ? mixedArgs : []);
    if (source === "form") {
      await clickControl("formMode");
      await setText("cy-mcp-args", JSON.stringify(mixedArgs));
    }

    if (switchModes) {
      for (let round = 0; round < 2; round++) {
        if (source === "json") await clickControl("formMode");
        expect(JSON.parse(document.querySelector<HTMLInputElement>("#cy-mcp-args")!.value)).toEqual(mixedArgs);
        expect(document.querySelector('[role="alert"]')).toBeNull();
        await clickControl("jsonMode");
        expect(JSON.parse(document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")!.value)).toEqual({
          mcpServers: { demo: { command: "node", args: mixedArgs, env: { EXAMPLE_ONLY: "unchanged" } } },
        });
        expect(document.querySelector('[role="alert"]')).toBeNull();
        if (source === "form") await clickControl("formMode");
      }
    }
    expect(addMcpServer).not.toHaveBeenCalled();
    await clickControl("confirm");

    expectSubmittedArgs(["--port", "3000", "true", "false", "0", ...args]);
  });

  it.each(["json", "form"] as const)("%s 中超大指数参数往返时不会变成 null，普通数字和布尔草稿保持原类型", async (source) => {
    const argsText = '["--limit",1e400,-1e400,3000,false]';
    const convertedDraft = ["--limit", "Infinity", "-Infinity", 3000, false];
    await openJson([]);
    if (source === "json") {
      await setText("cy-mcp-json", `{"mcpServers":{"demo":{"command":"node","args":${argsText},"env":{"EXAMPLE_ONLY":"unchanged"}}}}`);
    } else {
      await clickControl("formMode");
      await setText("cy-mcp-args", argsText);
      await clickControl("jsonMode");
    }

    for (let round = 0; round < 2; round++) {
      await clickControl("formMode");
      expect(JSON.parse(document.querySelector<HTMLInputElement>("#cy-mcp-args")!.value)).toEqual(convertedDraft);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      await clickControl("jsonMode");
      expect(JSON.parse(document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")!.value).mcpServers.demo.args).toEqual(convertedDraft);
      expect(document.querySelector('[role="alert"]')).toBeNull();
    }
    expect(addMcpServer).not.toHaveBeenCalled();
    if (source === "form") await clickControl("formMode");
    await clickControl("confirm");

    expectSubmittedArgs(["--limit", "Infinity", "-Infinity", "3000", "false"]);
  });

  it.each([
    { source: "json", invalidArg: null },
    { source: "json", invalidArg: { port: 3000 } },
    { source: "json", invalidArg: ["nested"] },
    { source: "form", invalidArg: null },
    { source: "form", invalidArg: { port: 3000 } },
    { source: "form", invalidArg: ["nested"] },
  ] as const)("$source 中混合数字、布尔和无效参数 $invalidArg 时不转换成字符串绕过校验", async ({ source, invalidArg }) => {
    const mixedArgs = ["--port", 3000, true, false, "", invalidArg];
    await openJson(source === "json" ? mixedArgs : []);
    if (source === "form") {
      await clickControl("formMode");
      await setText("cy-mcp-args", JSON.stringify(mixedArgs));
      await clickControl("jsonMode");
    } else {
      await clickControl("formMode");
      await clickControl("jsonMode");
    }
    expect(JSON.parse(document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")!.value).mcpServers.demo.args).toEqual(mixedArgs);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    if (source === "form") await clickControl("formMode");

    await clickControl("confirm");

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("settingsPage.mcp.argsInvalid");
    expect(addMcpServer).not.toHaveBeenCalled();
  });

  it.each([null, { port: 3000 }, ["nested"], "C:\nfolder.js"])("多服务器中混合数字、布尔和无效参数 %j 时，所有服务器都不会提交", async (invalidArg) => {
    await openJson([]);
    const input = JSON.stringify({
      mcpServers: {
        first: { command: "node", args: ["server.js", "--port", 3000, true] },
        second: { command: "node", args: ["--port", 3001, false, invalidArg] },
      },
    });
    await setText("cy-mcp-json", input);
    await clickControl("confirm");

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("settingsPage.mcp.argsInvalid");
    expect(document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")?.value).toBe(input);
    expect(addMcpServer).not.toHaveBeenCalled();
  });

  it.each([
    String.raw`C:\new\tool.js`,
    String.raw`D:\temp\file`,
  ])("直接提交 JSON 时先校验单反斜杠路径，保留草稿并允许修正：%s", async (path) => {
    await openJson([]);
    // 保留用户实际敲入的单反斜杠，不能用 JSON.stringify 自动修正输入。
    const input = String.raw`{"mcpServers":{"demo":{"command":"node","args":["${path}","--label","hello world"],"env":{"EXAMPLE_ONLY":"unchanged"}}}}`;
    await setText("cy-mcp-json", input);
    await clickControl("confirm");

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("settingsPage.mcp.argsInvalid");
    expect(document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")?.value).toBe(input);
    expect(addMcpServer).not.toHaveBeenCalled();

    const correctedArgs = [path, "--label", "hello world"];
    await setText("cy-mcp-json", JSON.stringify({
      mcpServers: { demo: { command: "node", args: correctedArgs, env: { EXAMPLE_ONLY: "unchanged" } } },
    }));
    await clickControl("confirm");
    expectSubmittedArgs(correctedArgs);
  });

  it("多服务器 JSON 中后一个参数无效时，前一个服务器也不会提前提交", async () => {
    await openJson([]);
    const input = String.raw`{"mcpServers":{"first":{"command":"node","args":["server.js"]},"second":{"command":"node","args":["C:\new\tool.js"]}}}`;
    await setText("cy-mcp-json", input);
    await clickControl("confirm");

    expect(document.querySelector('[role="alert"]')?.textContent).toContain("settingsPage.mcp.argsInvalid");
    expect(document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")?.value).toBe(input);
    expect(addMcpServer).not.toHaveBeenCalled();
  });

  it("正确参数通过校验后连接失败，仍显示添加失败提示并保留配置", async () => {
    await openJson(args);
    const input = document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")!.value;
    addMcpServer.mockResolvedValueOnce({ ok: false, error: "MCP error -32000: Connection closed" });
    await clickControl("confirm");

    expectSubmittedArgs(args);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("settingsPage.mcp.addFailed");
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain("settingsPage.mcp.argsInvalid");
    expect(document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")?.value).toBe(input);
  });

  it("表单中的普通空格分隔参数仍可切换并正常提交", async () => {
    await openJson([]);
    await clickControl("formMode");
    await setText("cy-mcp-args", "  -y   @modelcontextprotocol/server-memory  ");
    await clickControl("jsonMode");
    await clickControl("formMode");
    await clickControl("confirm");

    expectSubmittedArgs(["-y", "@modelcontextprotocol/server-memory"]);
  });

  it.each([
    String.raw`C:\new\tool.js`,
    String.raw`D:\temp\file`,
  ])("含控制字符的 JSON 参数允许反复切换，只在添加时提示并允许修正：%s", async (path) => {
    await openJson([]);
    const input = String.raw`{"mcpServers":{"demo":{"command":"node","args":["${path}","hello world"],"env":{"EXAMPLE_ONLY":"unchanged"}}}}`;
    await setText("cy-mcp-json", input);
    const original = JSON.parse(input);

    for (let round = 0; round < 3; round++) {
      await clickControl("formMode");
      expect(JSON.parse(document.querySelector<HTMLInputElement>("#cy-mcp-args")!.value))
        .toEqual(original.mcpServers.demo.args);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      await clickControl("jsonMode");
      expect(JSON.parse(document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")!.value)).toEqual(original);
      expect(document.querySelector('[role="alert"]')).toBeNull();
    }
    expect(addMcpServer).not.toHaveBeenCalled();

    await clickControl("confirm");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("settingsPage.mcp.argsInvalid");
    expect(addMcpServer).not.toHaveBeenCalled();

    const correctedArgs = [path, "hello world"];
    await setText("cy-mcp-json", JSON.stringify({
      mcpServers: { demo: { command: "node", args: correctedArgs, env: { EXAMPLE_ONLY: "unchanged" } } },
    }));
    await clickControl("confirm");
    expectSubmittedArgs(correctedArgs);
  });

  it.each([
    String.raw`["C:\new\tool.js", "--label", "hello world"]`,
    String.raw`["D:\temp\file"]`,
  ])("表单参数中的单反斜杠允许切换，添加时才校验：%s", async (input) => {
    await openJson(["original"]);
    await clickControl("formMode");
    await setText("cy-mcp-args", input);
    await clickControl("jsonMode");

    const json = document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")!.value;
    expect(JSON.parse(json).mcpServers.demo.args).toEqual(JSON.parse(input));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await clickControl("formMode");
    expect(JSON.parse(document.querySelector<HTMLInputElement>("#cy-mcp-args")!.value)).toEqual(JSON.parse(input));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(addMcpServer).not.toHaveBeenCalled();

    await clickControl("confirm");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("settingsPage.mcp.argsInvalid");
    expect(addMcpServer).not.toHaveBeenCalled();

    const correctedArgs = ["C:\\new\\tool.js", "hello world", ""];
    await setText("cy-mcp-args", JSON.stringify(correctedArgs));
    await clickControl("confirm");
    expectSubmittedArgs(correctedArgs);
  });

  it("表单残缺参数草稿切换时不报错，添加时回到表单校验而不提交旧 JSON", async () => {
    await openJson(["original"]);
    await clickControl("formMode");
    const input = '["unterminated';
    await setText("cy-mcp-args", input);

    await clickControl("jsonMode");
    expect(document.querySelector("#cy-mcp-json")).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await clickControl("formMode");
    expect(document.querySelector<HTMLInputElement>("#cy-mcp-args")?.value).toBe(input);
    expect(document.querySelector('[role="alert"]')).toBeNull();

    await clickControl("jsonMode");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await clickControl("confirm");
    expect(document.querySelector("#cy-mcp-json")).toBeNull();
    expect(document.querySelector<HTMLInputElement>("#cy-mcp-args")?.value).toBe(input);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("settingsPage.mcp.argsInvalid");
    expect(addMcpServer).not.toHaveBeenCalled();

    const correctedArgs = ["C:\\new\\tool.js", "hello world", ""];
    await setText("cy-mcp-args", JSON.stringify(correctedArgs));
    await clickControl("confirm");
    expectSubmittedArgs(correctedArgs);
  });

  it("stdio 引号参数、空参数和 Linux 服务端工作目录通过模式切换完整交给 IPC", async () => {
    await openJson([]);
    await clickControl("formMode");
    await setText("cy-mcp-args", String.raw`"C:\My Folder\server.js" --label 'hello world' escaped\ space ""`);
    await setText("cy-mcp-cwd", "/storage/my workspace");
    await clickControl("jsonMode");
    await clickControl("formMode");
    await clickControl("confirm");

    expect(addMcpServer).toHaveBeenCalledExactlyOnceWith({
      id: "demo", name: "demo", transport: "stdio", command: "node",
      cwd: "/storage/my workspace",
      args: ["C:\\My Folder\\server.js", "--label", "hello world", "escaped space", ""],
      env: { EXAMPLE_ONLY: "unchanged" },
    });
  });

  it.each(["http", "sse"] as const)("%s 远程配置反复切换后保留 URL 和请求头，不携带旧本地参数", async (transport) => {
    await openJson(["stale-local-argument"]);
    await clickControl("formMode");
    await clickControl("jsonMode");
    await setText("cy-mcp-json", JSON.stringify({
      mcpServers: { remote: { type: transport, url: "https://mcp.example.test/endpoint", headers: { Authorization: "Bearer example" } } },
    }));

    for (let round = 0; round < 2; round++) {
      await clickControl("formMode");
      expect(document.querySelector<HTMLInputElement>("#cy-mcp-url")?.value).toBe("https://mcp.example.test/endpoint");
      expect(document.querySelector("#cy-mcp-args")).toBeNull();
      await clickControl("jsonMode");
    }
    await clickControl("formMode");
    await clickControl("confirm");

    expect(addMcpServer).toHaveBeenCalledExactlyOnceWith({
      id: "remote", name: "remote", transport, url: "https://mcp.example.test/endpoint",
      headers: { Authorization: "Bearer example" },
    });
  });

  it("残缺 JSON 草稿切换时不报错，添加时回到 JSON 校验而不提交旧表单", async () => {
    await openJson(["original"]);
    await clickControl("formMode");
    await clickControl("jsonMode");
    const input = '{"mcpServers":{"demo":{"command":"node","args":[';
    await setText("cy-mcp-json", input);

    await clickControl("formMode");
    expect(document.querySelector("#cy-mcp-args")).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await clickControl("jsonMode");
    expect(document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")?.value).toBe(input);
    expect(document.querySelector('[role="alert"]')).toBeNull();

    await clickControl("formMode");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await clickControl("confirm");
    expect(document.querySelector("#cy-mcp-args")).toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>("#cy-mcp-json")?.value).toBe(input);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("settingsPage.mcp.jsonInvalid");
    expect(addMcpServer).not.toHaveBeenCalled();

    await setText("cy-mcp-json", JSON.stringify({
      mcpServers: { demo: { command: "node", args, env: { EXAMPLE_ONLY: "unchanged" } } },
    }));
    await clickControl("confirm");
    expectSubmittedArgs(args);
  });

  it.each(["json", "form"] as const)("清空 %s 草稿后切换不会提交另一边的旧配置", async (source) => {
    await openJson(["original"]);
    await clickControl("formMode");
    if (source === "json") {
      await clickControl("jsonMode");
      await setText("cy-mcp-json", "");
      await clickControl("formMode");
    } else {
      await setText("cy-mcp-name", "");
      await setText("cy-mcp-command", "");
      await setText("cy-mcp-args", "");
      await clickControl("jsonMode");
    }
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await clickControl("confirm");

    const expectedError = source === "json" ? "jsonEmpty" : "nameRequired";
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(`settingsPage.mcp.${expectedError}`);
    const sourceInput = source === "json" ? "#cy-mcp-json" : "#cy-mcp-name";
    expect(document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sourceInput)?.value).toBe("");
    expect(addMcpServer).not.toHaveBeenCalled();
  });

  it.each(["\b", "\u0000", "\u001b"])("JSON 导入的非空白控制字符不能绕过表单校验：%j", async (control) => {
    const invalidArgs = [`C:${control}folder.js`];
    await openJson(invalidArgs);
    await clickControl("formMode");

    expect(document.querySelector<HTMLInputElement>("#cy-mcp-args")?.value).toBe(JSON.stringify(invalidArgs));
    await clickControl("confirm");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("settingsPage.mcp.argsInvalid");
    expect(addMcpServer).not.toHaveBeenCalled();
  });
});
