// @vitest-environment jsdom
// MCP 设置面板纯函数测试 — 覆盖 JSON 粘贴解析、服务器 id 生成、表单/JSON 双向同步
// 这些函数直接处理用户粘贴的 JSON，解析错误会进入连接流程，属于高危输入面。
// mock i18n 与 @lobehub/icons：后者入口包含引用 @emoji-mart/data 的图标，
// node ESM 下 JSON 导入需要 attribute 会直接报错；纯函数测试用不到它们
import { describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@lobehub/icons", () => ({
  MCP: () => null,
}));

import {
  deriveServerId,
  entryToConfig,
  entryToFormPatch,
  formToEntry,
  parseJsonRecord,
  parseJsonServers,
  resolveTransport,
} from "./McpSettingsPanel";

/** 完整表单状态（McpFormState 未导出，用字面量构造结构等价对象） */
function makeForm(overrides: Record<string, string>): {
  name: string; transport: "stdio" | "http" | "sse"; cwd?: string; command: string; args: string; url: string; env: string; headers: string;
} {
  return { name: "", transport: "stdio", command: "", args: "", url: "", env: "", headers: "", ...overrides };
}

describe("parseJsonRecord（环境变量/请求头文本）", () => {
  it("空文本返回空对象", () => {
    expect(parseJsonRecord("")).toEqual({});
    expect(parseJsonRecord("   ")).toEqual({});
  });

  it("非法 JSON 抛异常", () => {
    expect(() => parseJsonRecord("{oops")).toThrow();
  });

  it("数组不是合法对象", () => {
    expect(() => parseJsonRecord("[1,2]")).toThrow();
  });

  it("值统一字符串化", () => {
    expect(parseJsonRecord('{"N": 42, "B": true}')).toEqual({ N: "42", B: "true" });
  });
});

describe("deriveServerId（工具名安全标识）", () => {
  it("ASCII 名称 slug 化", () => {
    expect(deriveServerId("My Server!", [])).toBe("my-server");
    expect(deriveServerId("weather_tools", [])).toBe("weather_tools");
  });

  it("非 ASCII 名称回退到 mcp- 时间戳（工具 id 会拼进 function name，厂商只接受 ASCII）", () => {
    expect(deriveServerId("天气服务", [])).toMatch(/^mcp-\d+$/);
  });

  it("与已有 id 冲突时追加序号", () => {
    expect(deriveServerId("weather", ["weather"])).toBe("weather-2");
    expect(deriveServerId("weather", ["weather", "weather-2"])).toBe("weather-3");
  });
});

describe("resolveTransport（JSON 条目类型推断）", () => {
  it("显式 type 优先", () => {
    expect(resolveTransport({ type: "http", url: "https://x" })).toBe("http");
    expect(resolveTransport({ type: "sse", url: "https://x" })).toBe("sse");
  });

  it("兼容官方生态别名 streamablehttp / streamable-http（麦当劳官方示例用法）", () => {
    expect(resolveTransport({ type: "streamablehttp", url: "https://mcp.mcd.cn" })).toBe("http");
    expect(resolveTransport({ type: "streamable-http", url: "https://x" })).toBe("http");
  });

  it("无 type 时有 url 无 command 按远程 http 处理", () => {
    expect(resolveTransport({ url: "https://x/mcp" })).toBe("http");
  });

  it("有 command 时视为本地进程，即使带 url", () => {
    expect(resolveTransport({ command: "npx", url: "https://x" })).toBe("stdio");
  });

  it("默认 stdio", () => {
    expect(resolveTransport({ command: "npx" })).toBe("stdio");
    expect(resolveTransport({})).toBe("stdio");
  });
});

describe("parseJsonServers（粘贴文本解析）", () => {
  it("支持 mcpServers 包裹格式", () => {
    const servers = parseJsonServers(
      '{"mcpServers": {"memory": {"command": "npx", "args": ["-y", "server-memory"]}}}',
    );
    expect(servers).toEqual([
      { name: "memory", entry: { command: "npx", args: ["-y", "server-memory"] } },
    ]);
  });

  it("支持裸 {server-name: {...}} 格式", () => {
    const servers = parseJsonServers('{"memory": {"command": "npx"}}');
    expect(servers).toEqual([{ name: "memory", entry: { command: "npx" } }]);
  });

  it("非对象条目被过滤", () => {
    const servers = parseJsonServers('{"a": "not-object", "b": 1, "c": {"command": "npx"}}');
    expect(servers).toEqual([{ name: "c", entry: { command: "npx" } }]);
  });

  it("根不是对象时抛异常", () => {
    expect(() => parseJsonServers("[1,2]")).toThrow();
    expect(() => parseJsonServers("null")).toThrow();
    expect(() => parseJsonServers("not json")).toThrow();
  });

  it("麦当劳官方配置示例端到端：streamablehttp + Authorization 请求头 → 远程 http 配置", () => {
    // README 2.3 节的原样示例（token 占位）
    const official = `{
      "mcpServers": {
        "mcd-mcp": {
          "type": "streamablehttp",
          "url": "https://mcp.mcd.cn",
          "headers": {
            "Authorization": "Bearer YOUR_MCP_TOKEN"
          }
        }
      }
    }`;
    const servers = parseJsonServers(official);
    expect(servers).toHaveLength(1);

    const config = entryToConfig(servers[0].name, servers[0].entry, []);
    expect(config).toEqual({
      id: "mcd-mcp",
      name: "mcd-mcp",
      transport: "http",
      url: "https://mcp.mcd.cn",
      headers: { Authorization: "Bearer YOUR_MCP_TOKEN" },
    });
  });
});

describe("表单 ↔ JSON 条目双向同步", () => {
  it("stdio 表单序列化含 command/args/env，不带 type", () => {
    const entry = formToEntry(makeForm({
      transport: "stdio", command: "npx", args: "  -y  @modelcontextprotocol/server-memory ", env: '{"A": "1"}',
    }));
    expect(entry).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      env: { A: "1" },
    });
  });

  it("http 表单序列化带显式 type 和 headers", () => {
    const entry = formToEntry(makeForm({
      transport: "http", url: " https://mcp.example.com/mcp ", headers: '{"Authorization": "Bearer t"}',
    }));
    expect(entry).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("stdio 往返：formToEntry → entryToFormPatch 恢复表单字段", () => {
    const entry = formToEntry(makeForm({
      name: "memory", transport: "stdio", command: "npx", args: "-y pkg", env: '{"K": "v"}',
    }));
    const patch = entryToFormPatch("memory", entry);
    expect(patch).toMatchObject({ name: "memory", transport: "stdio", command: "npx", args: "-y pkg" });
    expect(JSON.parse(patch.env ?? "{}")).toEqual({ K: "v" });
  });

  it.each([
    ["C:\\My Folder\\server.js", "--label", "hello world"],
    ["", " ", "  padded value  "],
    ['say "hello"', "C:\\folder\\", "a\\b", "'quoted'"],
    ["[value]", "--flag"],
    ["[", "--flag"],
  ])("JSON 参数经表单往返保留每项原值：%j", (...args: string[]) => {
    const entry = { command: "node", args };
    const patch = entryToFormPatch("demo", entry);
    expect(formToEntry({ ...makeForm({}), ...patch })).toEqual(entry);
  });

  it("表单支持 JSON 字符串数组，空数组不生成参数", () => {
    expect(formToEntry(makeForm({ command: "node", args: '["hello world", ""]' })))
      .toEqual({ command: "node", args: ["hello world", ""] });
    expect(formToEntry(makeForm({ command: "node", args: "[]" }))).toEqual({ command: "node" });
    expect(formToEntry(makeForm({ command: "node", args: String.raw`["\u4e2d\u6587", ""]` })))
      .toEqual({ command: "node", args: ["中文", ""] });
  });

  it("不能转换尚未写完的参数数组", () => {
    const args = '["unfinished"';
    expect(() => formToEntry(makeForm({ command: "node", args }))).toThrow();
  });

  it.each([
    { args: ["valid", { port: 3000 }] },
    { args: [null] },
    { args: [["nested"]] },
  ])("切换时保留不支持的参数类型，在添加时拒绝：%j", ({ args }) => {
    const entry = { command: "node", args };
    const patch = entryToFormPatch("demo", entry);
    const converted = formToEntry({ ...makeForm({}), ...patch });
    expect(converted).toEqual(entry);
    expect(() => entryToConfig("demo", converted, [])).toThrow();
  });

  it.each([
    String.raw`["C:\new\tool.js", "--label", "hello world"]`,
    String.raw`["D:\temp\file"]`,
    String.raw`["C:\repo\bin"]`,
  ])("单反斜杠路径允许转换，但添加时拒绝控制字符：%s", (args) => {
    const entry = formToEntry(makeForm({ command: "node", args }));
    expect(entry.args).toEqual(JSON.parse(args));
    expect(() => entryToConfig("demo", entry, [])).toThrow();
  });

  it.each(Array.from({ length: 32 }, (_, code) => code))("拒绝参数中的 C0 控制字符：%i", (code) => {
    const args = JSON.stringify([`before${String.fromCharCode(code)}after`]);
    expect(formToEntry(makeForm({ command: "node", args })).args).toEqual(JSON.parse(args));
    expect(() => entryToConfig("demo", { command: "node", args: JSON.parse(args) }, [])).toThrow();
  });

  it("接受正确双写反斜杠的 Windows 路径，并保留空参数", () => {
    const args = String.raw`["C:\\new\\tool.js", "D:\\temp\\file", "C:\\repo\\bin", ""]`;
    expect(formToEntry(makeForm({ command: "node", args }))).toEqual({
      command: "node",
      args: ["C:\\new\\tool.js", "D:\\temp\\file", "C:\\repo\\bin", ""],
    });
  });

  it("普通文本参数仍按空白分隔，保留单反斜杠路径", () => {
    const args = "C:\\new\\tool.js\t--label\nhello";
    expect(formToEntry(makeForm({ command: "node", args }))).toEqual({
      command: "node",
      args: ["C:\\new\\tool.js", "--label", "hello"],
    });
  });

  it("普通参数的引号和转义空格在模式往返后仍保留 argv 边界及服务端工作目录", () => {
    const entry = formToEntry(makeForm({
      command: " node ", cwd: " /storage/my workspace ",
      args: String.raw`"C:\My Folder\server.js" --label 'hello world' escaped\ space ""`,
    }));
    expect(entry).toEqual({
      command: "node", cwd: "/storage/my workspace",
      args: ["C:\\My Folder\\server.js", "--label", "hello world", "escaped space", ""],
    });
    const converted = formToEntry({ ...makeForm({}), ...entryToFormPatch("demo", entry) });
    expect(converted).toEqual(entry);
    expect(entryToConfig("demo", converted, []).cwd).toBe("/storage/my workspace");
  });

  it("普通参数的残缺引号不能作为有效草稿转换", () => {
    expect(() => formToEntry(makeForm({ command: "node", args: '--label "unfinished' }))).toThrow();
  });

  it("http 往返：url 和 headers 恢复", () => {
    const entry = formToEntry(makeForm({
      transport: "http", url: "https://mcp.example.com/mcp", headers: '{"Authorization": "Bearer t"}',
    }));
    const patch = entryToFormPatch("api", entry);
    expect(patch).toMatchObject({ name: "api", transport: "http", url: "https://mcp.example.com/mcp" });
    expect(JSON.parse(patch.headers ?? "{}")).toEqual({ Authorization: "Bearer t" });
  });

  it("stdio 往返保留空参数、引号、路径和换行", () => {
    const args = ["", "two words", 'a"b', "C:\\tools\\server", "line\nbreak", "tab\tvalue", "'single'"];
    const entry = { command: "node", args };
    const patch = entryToFormPatch("complex", entry);
    expect(formToEntry(makeForm({ ...patch, transport: "stdio" })).args).toEqual(args);
  });
});

describe("entryToConfig（后端配置组装）", () => {
  it("超出数值范围的 JSON 参数仍按原有字符串转换处理，模式往返不会变成 null", () => {
    const [{ name, entry }] = parseJsonServers('{"mcpServers":{"demo":{"command":"node","args":[1e400,-1e400,3000,false]}}}');
    const expected = ["Infinity", "-Infinity", "3000", "false"];
    expect(entryToConfig(name, entry, []).args).toEqual(expected);

    const patch = entryToFormPatch(name, entry);
    const converted = formToEntry({ ...makeForm({}), ...patch });
    expect(converted.args).toEqual(["Infinity", "-Infinity", 3000, false]);
    expect(entryToConfig(name, JSON.parse(JSON.stringify(converted)), []).args).toEqual(expected);

    const fromForm = formToEntry(makeForm({ command: "node", args: "[1e400,-1e400,3000,false]" }));
    expect(fromForm.args).toEqual(["Infinity", "-Infinity", 3000, false]);
    expect(entryToConfig(name, JSON.parse(JSON.stringify(fromForm)), []).args).toEqual(expected);
  });

  it.each([
    { args: ["--port", 3000], expected: ["--port", "3000"] },
    { args: ["--enabled", true, "--disabled", false], expected: ["--enabled", "true", "--disabled", "false"] },
    { args: [0, -42, 1.25, 1e3], expected: ["0", "-42", "1.25", "1000"] },
    { args: ["C:\\My Folder\\server.js", "", "hello world", 3000, false], expected: ["C:\\My Folder\\server.js", "", "hello world", "3000", "false"] },
  ])("兼容数字和布尔参数，直接提交与模式往返后的配置一致：%j", ({ args, expected }) => {
    const [{ name, entry }] = parseJsonServers(JSON.stringify({ mcpServers: { demo: { command: "node", args } } }));
    expect(entryToConfig(name, entry, []).args).toEqual(expected);

    const patch = entryToFormPatch(name, entry);
    const converted = formToEntry({ ...makeForm({}), ...patch });
    expect(converted).toEqual(entry);
    expect(entryToConfig(name, converted, []).args).toEqual(expected);
    // 校验只构造提交配置，不修改编辑中的原始草稿。
    expect(entry.args).toEqual(args);
    expect(converted.args).toEqual(args);
  });

  it.each([
    { args: null },
    { args: "--label hello" },
    { args: 3000 },
    { args: false },
    { args: [null] },
    { args: [{ port: 3000 }] },
    { args: [["nested"]] },
    { args: ["--port", 3000, true, null] },
    { args: ["--port", 3000, false, "bad\npath"] },
  ])("JSON 直接提交时拒绝非数组或包含不支持值的参数：%j", ({ args }) => {
    expect(() => entryToConfig("demo", { command: "node", args }, [])).toThrow();
  });

  it("允许省略参数或显式传入空数组", () => {
    expect(entryToConfig("demo", { command: "node" }, []).args).toBeUndefined();
    expect(entryToConfig("demo", { command: "node", args: [] }, []).args).toEqual([]);
  });

  it("JSON 直接提交时保留正确转义的 Windows 路径和空参数", () => {
    const [{ name, entry }] = parseJsonServers(String.raw`{"mcpServers":{"demo":{"command":"node","args":["C:\\new\\tool.js","hello world",""]}}}`);
    expect(entryToConfig(name, entry, []).args).toEqual(["C:\\new\\tool.js", "hello world", ""]);
  });

  it("保留空字符串参数的位置", () => {
    const args = ["", "--label", "", "hello world"];
    expect(entryToConfig("demo", { command: "node", args }, []).args).toEqual(args);
  });
  it("stdio 条目透传 command/args/env 并生成 id", () => {
    const config = entryToConfig("weather", { command: "npx", args: ["-y", "p"], env: { K: "v" } }, []);
    expect(config).toEqual({
      id: "weather", name: "weather", transport: "stdio",
      command: "npx", args: ["-y", "p"], env: { K: "v" },
    });
  });

  it("远程条目透传 url/headers 并按现有 id 去重", () => {
    const config = entryToConfig("api", { type: "http", url: " https://x/mcp ", headers: { A: "b" } }, ["api"]);
    expect(config).toEqual({
      id: "api-2", name: "api", transport: "http",
      url: "https://x/mcp", headers: { A: "b" },
    });
  });
});
