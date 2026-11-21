import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  expandCommandTemplate,
  expandFileCommandText,
  expandLatestUserCommand,
  findFileCommand,
  listFileCommands,
  parseCommandInvocation,
  workspaceCommandDirectory,
} from "./file-commands";
import { parseChannelControlCommand } from "../channels/control-commands";

let root: string;
let userDir: string;
let workspaceRoot: string;

function writeCommand(dir: string, name: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content, "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-commands-"));
  userDir = path.join(root, "userData", "commands");
  workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("expandCommandTemplate", () => {
  it("替换 $ARGUMENTS 与位置参数，缺失位置参数为空，引号内空格保留", () => {
    const body = "审查 $1，重点 $2，忽略 [$3]。原文：$ARGUMENTS";
    expect(expandCommandTemplate(body, `src/a.ts "性能 与 边界"`))
      .toBe(`审查 src/a.ts，重点 性能 与 边界，忽略 []。原文：src/a.ts "性能 与 边界"`);
  });

  it("模板没有占位符时参数追加在末尾，不静默丢弃", () => {
    expect(expandCommandTemplate("总结今天的工作。", "只看上午")).toBe("总结今天的工作。\n\n参数：只看上午");
    expect(expandCommandTemplate("总结今天的工作。", "")).toBe("总结今天的工作。");
  });

  it("参数里的 $ 符号不会被二次替换", () => {
    expect(expandCommandTemplate("值=$ARGUMENTS", "$1 $ARGUMENTS")).toBe("值=$1 $ARGUMENTS");
  });
});

describe("parseCommandInvocation", () => {
  it("命令名规则与 Skill 斜杠一致", () => {
    expect(parseCommandInvocation("/review src/a.ts")).toEqual({ name: "review", args: "src/a.ts" });
    expect(parseCommandInvocation("/review\n多行\n参数")).toEqual({ name: "review", args: "多行\n参数" });
    expect(parseCommandInvocation("/Review")).toBeNull();
    expect(parseCommandInvocation("//x")).toBeNull();
    expect(parseCommandInvocation("/a/b")).toBeNull();
    expect(parseCommandInvocation("/../etc/passwd")).toBeNull();
    expect(parseCommandInvocation("普通文本")).toBeNull();
  });
});

describe("命令文件查找与优先级", () => {
  it("工作区命令优先于用户命令；frontmatter 可选", () => {
    writeCommand(userDir, "review", "---\ndescription: 用户版\nargument-hint: <文件>\n---\n用户版 $ARGUMENTS");
    writeCommand(workspaceCommandDirectory(workspaceRoot), "review", "工作区版 $1");
    const command = findFileCommand("review", { userDir, workspaceRoot });
    expect(command?.source).toBe("workspace");
    expect(command?.body).toBe("工作区版 $1");

    const userOnly = findFileCommand("review", { userDir });
    expect(userOnly).toMatchObject({ source: "user", description: "用户版", argumentHint: "<文件>" });
  });

  it("mode 限制：当前模式不可用时回落到低优先级的同名命令", () => {
    writeCommand(workspaceCommandDirectory(workspaceRoot), "plan", "---\nmode: code\n---\n工作区 code 专用");
    writeCommand(userDir, "plan", "---\nmode: [work, learn]\n---\n用户通用");
    expect(findFileCommand("plan", { userDir, workspaceRoot }, "code")?.source).toBe("workspace");
    expect(findFileCommand("plan", { userDir, workspaceRoot }, "work")?.source).toBe("user");
    expect(findFileCommand("plan", { userDir, workspaceRoot }, "chat")).toBeNull();
  });

  it("列表去重保留高优先级，跳过非法文件名、保留名与超限文件", () => {
    writeCommand(userDir, "review", "用户版");
    writeCommand(userDir, "daily", "日报");
    writeCommand(userDir, "Bad_Name", "非法");
    writeCommand(userDir, "stop", "保留名不应生效");
    writeCommand(userDir, "huge", "x".repeat(70 * 1024));
    writeCommand(workspaceCommandDirectory(workspaceRoot), "review", "工作区版");
    const list = listFileCommands({ userDir, workspaceRoot });
    expect(list.map((c) => `${c.name}:${c.source}`)).toEqual(["daily:user", "review:workspace"]);
  });

  it("符号链接形式的命令文件被拒绝（防止工作区借链接读目录外文件）", () => {
    const secret = path.join(root, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET");
    const dir = workspaceCommandDirectory(workspaceRoot);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.symlinkSync(secret, path.join(dir, "leak.md"), "file");
    } catch {
      return; // Windows 无符号链接权限时跳过
    }
    expect(findFileCommand("leak", { workspaceRoot })).toBeNull();
  });
});

describe("消息展开", () => {
  it("展开最后一条 user 消息，附件路径段保持在末尾，不改其他消息", () => {
    writeCommand(userDir, "review", "请审查 $1，关注：$ARGUMENTS");
    const messages = [
      { role: "user", content: "/review old" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "/review a.ts 并发\n\n【本轮附件路径】\n- a.ts: C:/a.ts" },
    ];
    const expansion = expandLatestUserCommand(messages, { userDir });
    expect(expansion).toMatchObject({ name: "review", source: "user" });
    expect(messages[2].content).toBe("请审查 a.ts，关注：a.ts 并发\n\n【本轮附件路径】\n- a.ts: C:/a.ts");
    expect(messages[0].content).toBe("/review old");
  });

  it("未知命令原样放行（交给 Skill 斜杠激活）", () => {
    const messages = [{ role: "user", content: "/cyrene-plan-mode 开始" }];
    expect(expandLatestUserCommand(messages, { userDir, workspaceRoot })).toBeNull();
    expect(messages[0].content).toBe("/cyrene-plan-mode 开始");
  });

  it("渠道控制命令不受命令文件影响", () => {
    writeCommand(userDir, "stop", "这是一个恶意的同名命令");
    writeCommand(userDir, "status", "同名命令");
    expect(expandFileCommandText("/stop", { userDir })).toBeNull();
    expect(expandFileCommandText("/status", { userDir })).toBeNull();
    expect(parseChannelControlCommand("/stop")).toBe("stop");
    expect(parseChannelControlCommand("/status")).toBe("status");
  });
});
