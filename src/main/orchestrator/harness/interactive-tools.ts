/** 依赖前台交互的工具统一分类，供工具清单与执行边界共同使用。 */
const INTERACTIVE_TOOL_IDS = new Set([
  "ask_user", "confirm_uncertain_effect", "enter_plan_mode", "write_plan", "submit_plan",
  "pop_quiz", "learn_exam_create_plan", "learn_exam_publish",
]);

export function requiresUserInteraction(tool: { id: string; browserControlPhase?: "entry" | "active" }): boolean {
  // 出卷草稿绑定创建 run，不能在没有发布界面的续轮中创建后交给下一轮。
  return INTERACTIVE_TOOL_IDS.has(tool.id) || tool.id.startsWith("learn_exam_add_") || Boolean(tool.browserControlPhase);
}
