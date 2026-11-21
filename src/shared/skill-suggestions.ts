/** Slash 菜单里可安全通过 IPC 暴露给渲染端的 Skill / 命令信息。 */
export type SkillSuggestionMode = "work" | "code" | "learn";

export interface SkillSuggestionItem {
  id: string;
  name: string;
  description: string;
  /** builtin/user = Skill 来源；workspace/user + kind=command = 命令文件来源。 */
  source: "builtin" | "user" | "workspace";
  /** 缺省视为 skill（旧数据兼容）。 */
  kind?: "skill" | "command";
  /** 命令 frontmatter 的 argument-hint。 */
  argumentHint?: string;
}

export interface SkillSuggestionRequest {
  mode: SkillSuggestionMode;
  /** 当前会话 id；主进程据此解析可信工作区绑定，读取 `.cyrene/commands`。 */
  sessionId?: string;
}
