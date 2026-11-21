import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const userData = vi.hoisted(() => ({ dir: "" }));

vi.mock("electron", () => ({ app: { getPath: () => userData.dir } }));
vi.mock("../../../permission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permission")>(),
  getCurrentLevel: () => "full",
}));
vi.mock("../../vision-captioner", () => ({ captionImage: vi.fn() }));

import { toolRegistry } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import "../fs-tools";
import { executeMultiEdit } from "./multi-edit-tool";
import { resetFileReadTrackerForTest } from "../file-read-tracker";

let workspace: string;
let file: string;

function ctx(conversationId = "conv-a"): ToolContext {
  return { userQuery: "", conversationId, resolvedWorkspaceRoot: workspace };
}

async function readFile(target: string, context = ctx()): Promise<void> {
  const output = JSON.parse(await toolRegistry.getById("read_file")!.execute({ path: target }, context)) as { success?: boolean };
  expect(output.success).not.toBe(false);
}

async function multiEdit(edits: unknown, context = ctx()) {
  return JSON.parse(await executeMultiEdit({ file_path: file, edits }, context)) as {
    success: boolean;
    errorCode?: string;
    error?: string;
    failedEdit?: number;
    appliedEdits?: number;
    replacements?: number[];
  };
}

beforeEach(() => {
  resetFileReadTrackerForTest();
  workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "multi-edit-")));
  userData.dir = workspace;
  file = path.join(workspace, "app.ts");
  fs.writeFileSync(file, "const a = 1;\nconst b = 2;\nlog(a);\nlog(a);\n");
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("multi_edit 工具", () => {
  it("未先读取文件时拒绝，文件不变", async () => {
    const before = fs.readFileSync(file, "utf8");
    const result = await multiEdit([{ old_string: "const b = 2;", new_string: "const b = 3;" }]);
    expect(result).toMatchObject({ success: false, errorCode: "FILE_NOT_READ" });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("其他会话读过不算本会话读过", async () => {
    await readFile(file, ctx("conv-other"));
    const result = await multiEdit([{ old_string: "const b = 2;", new_string: "const b = 3;" }]);
    expect(result).toMatchObject({ success: false, errorCode: "FILE_NOT_READ" });
  });

  it("读取后文件被外部修改则要求重新读取", async () => {
    await readFile(file);
    fs.appendFileSync(file, "// external\n");
    const result = await multiEdit([{ old_string: "const b = 2;", new_string: "const b = 3;" }]);
    expect(result).toMatchObject({ success: false, errorCode: "FILE_CHANGED_SINCE_READ" });
  });

  it("按顺序应用，后一处在前一处的结果上匹配；replace_all 替换全部", async () => {
    await readFile(file);
    const result = await multiEdit([
      { old_string: "const b = 2;", new_string: "const total = 2;" },
      { old_string: "log(a);", new_string: "print(a);", replace_all: true },
      { old_string: "const total = 2;", new_string: "const total = a + 2;" },
    ]);
    expect(result).toMatchObject({ success: true, appliedEdits: 3, replacements: [1, 2, 1] });
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 1;\nconst total = a + 2;\nprint(a);\nprint(a);\n");
  });

  it("任一处失败整体不写入，并指出失败的是第几处", async () => {
    await readFile(file);
    const before = fs.readFileSync(file, "utf8");
    const result = await multiEdit([
      { old_string: "const a = 1;", new_string: "const a = 10;" },
      { old_string: "missing text", new_string: "x" },
    ]);
    expect(result).toMatchObject({ success: false, errorCode: "OLD_STRING_NOT_FOUND", failedEdit: 2 });
    expect(result.error).toContain("第 2 处");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("不带 replace_all 时多处匹配报错且不写入", async () => {
    await readFile(file);
    const before = fs.readFileSync(file, "utf8");
    const result = await multiEdit([{ old_string: "log(a);", new_string: "print(a);" }]);
    expect(result).toMatchObject({ success: false, errorCode: "MULTIPLE_MATCHES", failedEdit: 1 });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("成功写入后可以继续编辑，无需重新读取", async () => {
    await readFile(file);
    expect((await multiEdit([{ old_string: "const a = 1;", new_string: "const a = 5;" }])).success).toBe(true);
    expect((await multiEdit([{ old_string: "const a = 5;", new_string: "const a = 6;" }])).success).toBe(true);
    expect(fs.readFileSync(file, "utf8").startsWith("const a = 6;")).toBe(true);
  });

  it("CRLF 文件用 LF 写的 old_string 也能 replace_all，并保持 CRLF", async () => {
    fs.writeFileSync(file, "x();\r\ny();\r\nx();\r\ny();\r\n");
    await readFile(file);
    const result = await multiEdit([{ old_string: "x();\ny();", new_string: "z();", replace_all: true }]);
    expect(result).toMatchObject({ success: true, replacements: [2] });
    expect(fs.readFileSync(file, "utf8")).toBe("z();\r\nz();\r\n");
  });

  it("参数校验：空数组、old 与 new 相同、replace_all 配空 old_string", async () => {
    await readFile(file);
    expect(await multiEdit([])).toMatchObject({ success: false, errorCode: "INVALID_INPUT" });
    expect(await multiEdit([{ old_string: "a", new_string: "a" }])).toMatchObject({ success: false, errorCode: "INVALID_INPUT" });
    expect(await multiEdit([{ old_string: "", new_string: "a", replace_all: true }])).toMatchObject({ success: false, errorCode: "INVALID_INPUT" });
  });

  it("只读子任务不允许写入", async () => {
    await readFile(file);
    const result = await multiEdit([{ old_string: "const a = 1;", new_string: "const a = 2;" }], { ...ctx(), readOnly: true });
    expect(result).toMatchObject({ success: false, errorCode: "PERMISSION_DENIED" });
  });
});
