import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyTaskMethodRequest, createTaskMethodRun } from "./task-method-learning";
import { RelationshipLogStore } from "../relationship/relationship-log-core";

describe("工作区做事经验", () => {
  let root: string;
  let workspace: string;
  let file: string;
  let unrelated: string;
  const tools = new Set(["Read", "Grep", "Glob"]);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-task-method-"));
    workspace = path.join(root, "project");
    file = path.join(workspace, "minutes.md");
    unrelated = path.join(workspace, "other.md");
    fs.mkdirSync(workspace);
    fs.writeFileSync(file, "会期改到周一");
    fs.writeFileSync(unrelated, "周末安排");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function grep(filenames: string[]) {
    return {
      toolId: "Grep", args: { pattern: "会期" }, status: "succeeded" as const,
      output: JSON.stringify({ numMatches: filenames.length, filenames, ...(filenames.length ? {} : { message: "未找到匹配内容。" }) }),
    };
  }
  function read(filename: string) {
    return { toolId: "Read", args: { file_path: filename }, status: "succeeded" as const, output: "    1 | 实际读到的内容" };
  }

  it("只有读取命中文件的独立成功轮次形成经验，重启后只为同工作区可用工具提供提示", () => {
    const ask = "查找哪份文档提到会期";
    const task = classifyTaskMethodRequest(ask)!;
    const db = path.join(root, "relationship.json");
    const store = new RelationshipLogStore(db);
    const revision = store.getTaskLearningRevision()!;
    for (const turn of ["first", "second"]) {
      const run = createTaskMethodRun(task, ask, workspace, tools, (key, kind) => store.getTaskLessons(key, kind))!;
      expect(run.prompt).toBe("");
      run.observe(grep(["minutes.md"]), 1);
      run.observe(read(unrelated), 2);
      expect(run.observations()).toEqual([]);
      run.observe(read(file), 1);
      expect(run.observations()).toEqual([]);
      run.observe(read(file), 3);
      expect(run.observations()).toEqual([{ method: "search-then-read", outcome: "worked" }]);
      store.recordTaskObservation({
        ...run.observations()[0]!, task, workspaceKey: run.workspaceKey, conversationId: "private", userTurnId: turn, revision,
      });
    }
    const restarted = new RelationshipLogStore(db);
    const lessons = (key: string, kind: typeof task) => restarted.getTaskLessons(key, kind);
    const next = createTaskMethodRun(task, ask, workspace, tools, lessons)!;
    expect(next.prompt).toContain("先用 Grep");
    expect(next.prompt).not.toContain("minutes.md");
    expect(createTaskMethodRun(task, ask, root, tools, lessons)?.prompt).toBe("");
    expect(createTaskMethodRun(task, ask, workspace, new Set(["Read"]), lessons)).toBeUndefined();
    next.observe(grep([]), 1);
    expect(next.observations()).toEqual([{ method: "search-then-read", outcome: "missed" }]);
    next.discard();
    expect(next.observations()).toEqual([]);
  });

  it("分清直接读、先找文件再读、以及只盘点目录", () => {
    const make = (text: string) => createTaskMethodRun(classifyTaskMethodRequest(text)!, text, workspace, tools, () => [])!;
    const direct = make("帮我读一下 minutes.md");
    direct.observe(read(unrelated), 1);
    expect(direct.observations()).toEqual([]);
    direct.observe({ ...read(file), output: "    1 |     缩进内容" }, 1);
    expect(direct.observations()).toEqual([{ method: "read-direct", outcome: "worked" }]);

    const glob = {
      toolId: "Glob", args: { pattern: "**/*" }, status: "succeeded" as const,
      output: JSON.stringify({ numFiles: 2, filenames: ["minutes.md", "other.md"] }),
    };
    const located = make("帮我读一下 minutes.md");
    located.observe({ ...read(path.join(workspace, "old", "minutes.md")), status: "failed", output: "", errorCode: "FILE_NOT_FOUND" }, 1);
    located.observe(glob, 2);
    located.observe(read(file), 3);
    expect(located.observations()).toEqual([
      { method: "list-then-read", outcome: "worked" }, { method: "read-direct", outcome: "missed" },
    ]);
    const list = make("列出工作区有哪些文件");
    list.observe(glob, 1);
    expect(list.observations()).toEqual([{ method: "list-directory", outcome: "worked" }]);
  });

  it("跳过外部文件和会改动内容的请求", () => {
    const outside = path.join(root, "minutes.md");
    fs.writeFileSync(outside, "工作区以外");
    const direct = createTaskMethodRun("read-document", "读一下 minutes.md", workspace, tools, () => [])!;
    direct.observe(read(outside), 1);
    expect(direct.observations()).toEqual([]);
    expect(classifyTaskMethodRequest("读取 minutes.md 并改写内容")).toBeUndefined();
  });
});
