import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SKILL_SOURCE_MARKER,
  isValidSkillId,
  writeUserSkill,
} from "./skill-authoring";
import { createSkillManagementTools } from "./skill-management-tools";
import { scanSkills } from "./skill-scanner";
import { SkillRegistry } from "./skill-registry";
import { requiresUserInteraction } from "../orchestrator/harness/interactive-tools";

let root: string;
let userSkillsDir: string;
let builtinSkillDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-skill-write-"));
  userSkillsDir = path.join(root, "userData", "skills");
  builtinSkillDir = path.join(root, "install", "skills");
  fs.mkdirSync(path.join(builtinSkillDir, "cyrene-plan-mode"), { recursive: true });
  fs.writeFileSync(path.join(builtinSkillDir, "cyrene-plan-mode", "SKILL.md"), "---\nname: cyrene-plan-mode\ndescription: 内置\n---\n内置正文");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const dirs = () => ({ userSkillsDir, builtinSkillDir });

describe("isValidSkillId", () => {
  it("只接受小写字母/数字以单个短横线连接", () => {
    for (const id of ["weekly-report", "a", "x1-y2"]) expect(isValidSkillId(id)).toBe(true);
    for (const id of ["", "Weekly", "a_b", "-a", "a-", "a--b", "../x", "a/b", "a.b", "中文", "a".repeat(65)]) {
      expect(isValidSkillId(id)).toBe(false);
    }
  });
});

describe("writeUserSkill", () => {
  it("写出可被扫描器加载的 SKILL.md，含 name/description/modes，并记录自写来源", () => {
    const result = writeUserSkill({
      id: "weekly-report",
      description: "写周报: 汇总本周提交与会议",
      body: "# 周报\n1. 拉取提交\n2. 汇总",
      modes: ["work"],
    }, dirs());
    expect(result.updated).toBe(false);
    const [entry] = scanSkills(userSkillsDir, "user");
    expect(entry).toMatchObject({ id: "weekly-report", name: "weekly-report", description: "写周报: 汇总本周提交与会议", modes: ["work"] });
    const origin = JSON.parse(fs.readFileSync(path.join(userSkillsDir, "weekly-report", SKILL_SOURCE_MARKER), "utf8"));
    expect(origin.origin).toBe("authored");
  });

  it("已存在时不传 overwrite 拒绝，传 overwrite=true 才更新且保留 references", () => {
    writeUserSkill({ id: "weekly-report", description: "v1", body: "旧正文" }, dirs());
    const refDir = path.join(userSkillsDir, "weekly-report", "references");
    fs.mkdirSync(refDir);
    fs.writeFileSync(path.join(refDir, "tpl.md"), "模板");

    expect(() => writeUserSkill({ id: "weekly-report", description: "v2", body: "新正文" }, dirs()))
      .toThrow(expect.objectContaining({ code: "E_SKILL_EXISTS" }));
    expect(fs.readFileSync(path.join(userSkillsDir, "weekly-report", "SKILL.md"), "utf8")).toContain("旧正文");

    const result = writeUserSkill({ id: "weekly-report", description: "v2", body: "新正文", overwrite: true }, dirs());
    expect(result.updated).toBe(true);
    expect(fs.readFileSync(path.join(userSkillsDir, "weekly-report", "SKILL.md"), "utf8")).toContain("新正文");
    expect(fs.existsSync(path.join(refDir, "tpl.md"))).toBe(true);
  });

  it("不能创建或覆盖内置 Skill 同名目录（即使 overwrite=true）", () => {
    expect(() => writeUserSkill({ id: "cyrene-plan-mode", description: "冒充", body: "x", overwrite: true }, dirs()))
      .toThrow(expect.objectContaining({ code: "E_SKILL_BUILTIN" }));
    expect(fs.existsSync(path.join(userSkillsDir, "cyrene-plan-mode"))).toBe(false);
  });

  it("不能覆盖随安装包快照分发或手动放置的用户 Skill", () => {
    fs.mkdirSync(path.join(userSkillsDir, "xlsx"), { recursive: true });
    fs.writeFileSync(path.join(userSkillsDir, "xlsx", "SKILL.md"), "---\nname: xlsx\ndescription: 快照\n---\n原文");
    expect(() => writeUserSkill({ id: "xlsx", description: "改", body: "改", overwrite: true }, dirs()))
      .toThrow(expect.objectContaining({ code: "E_SKILL_UNMANAGED" }));
    expect(fs.readFileSync(path.join(userSkillsDir, "xlsx", "SKILL.md"), "utf8")).toContain("原文");
  });

  it("非法 id 与非法模式在写盘前拒绝", () => {
    expect(() => writeUserSkill({ id: "../escape", description: "d", body: "b" }, dirs()))
      .toThrow(expect.objectContaining({ code: "E_SKILL_ID_INVALID" }));
    expect(fs.existsSync(path.join(root, "userData", "escape"))).toBe(false);
  });

  it("frontmatter 特殊字符被正确转义", () => {
    writeUserSkill({ id: "yaml-safe", name: "a: b", description: "含 --- 与 # 与 \"引号\"", body: "正文" }, dirs());
    const [entry] = scanSkills(userSkillsDir, "user");
    expect(entry).toMatchObject({ name: "a: b", description: "含 --- 与 # 与 \"引号\"" });
  });

  it("重新注册后正文缓存失效，更新立即可见", () => {
    writeUserSkill({ id: "cache-test", description: "d", body: "第一版" }, dirs());
    const registry = new SkillRegistry();
    registry.register(scanSkills(userSkillsDir, "user")[0]);
    expect(registry.getBody("cache-test")).toBe("第一版");
    writeUserSkill({ id: "cache-test", description: "d", body: "第二版", overwrite: true }, dirs());
    registry.register(scanSkills(userSkillsDir, "user")[0]);
    expect(registry.getBody("cache-test")).toBe("第二版");
  });
});

describe("skill_write / skill_install 工具", () => {
  const tools = () => {
    const rescan = vi.fn(() => 1);
    const [skillWrite, skillInstall] = createSkillManagementTools({ getDirectories: dirs, rescan });
    return { skillWrite, skillInstall, rescan };
  };

  it("声明 fs-write 风险、逐次审批，且不在无交互运行中暴露", () => {
    const { skillWrite, skillInstall } = tools();
    for (const tool of [skillWrite, skillInstall]) {
      expect(tool.risk).toBe("fs-write");
      expect(tool.requiresApproval).toBe(true);
      expect(tool.effectKind).toBe("mutation");
      expect(requiresUserInteraction(tool)).toBe(true);
    }
  });

  it("写完自动重新扫描", async () => {
    const { skillWrite, rescan } = tools();
    const output = await skillWrite.execute({ id: "daily-plan", description: "做日计划", body: "步骤" }, { userQuery: "" });
    expect(output).toContain("已创建 Skill: daily-plan");
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it("渠道后台/无交互运行直接拒绝，不写盘", async () => {
    const { skillWrite, skillInstall, rescan } = tools();
    const channel = await skillWrite.execute({ id: "daily-plan", description: "d", body: "b" }, {
      userQuery: "", channelContext: { channel: "wechat", targetId: "u", sessionId: "s" },
    });
    expect(channel).toContain("E_APPROVAL_REQUIRED");
    const scheduled = await skillInstall.execute({ source: "octo/skills" }, { userQuery: "", allowUserInteraction: false });
    expect(scheduled).toContain("E_APPROVAL_REQUIRED");
    expect(rescan).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(userSkillsDir, "daily-plan"))).toBe(false);
  });

  it("错误以错误码返回给模型", async () => {
    const { skillWrite } = tools();
    expect(await skillWrite.execute({ id: "cyrene-plan-mode", description: "d", body: "b" }, { userQuery: "" }))
      .toContain("E_SKILL_BUILTIN");
    expect(await skillWrite.execute({ id: "ok-id", description: "d", body: "b", modes: ["chat"] }, { userQuery: "" }))
      .toContain("E_SKILL_MODES_INVALID");
  });
});
