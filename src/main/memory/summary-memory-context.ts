import path from "node:path";
import type { ChatSessionRecord } from "../../shared/chat-types";
import { resolveSummaryMemoryPaths } from "./summary-memory-paths";
import { readSummaryFile, type SummaryReadResult } from "./summary-memory-store";
import { areSummaryMemorySourcesCurrent } from "./summary-memory-sources";
import { activeMemorySourceFacts } from "./memory-owner-recall";
import { createRecallScorer, matchesRecallConversationDate, mergeScopedRecall, presentRecallDetail, recallAlreadyVisible, selectRecallByTopic } from "./recall-presentation";
import { recallEventDateMatches, verifiedRecallEventDates, type RecallQueryPlan } from "./recall-query-plan";

export interface SummaryMemoryContext {
  sessionPath: string;
  workspacePath?: string;
  sessionContent: string;
  workspaceContent?: string;
  sessionTruncated: boolean;
  workspaceTruncated: boolean;
  stablePrompt: string;
  runtimeContext: string;
}

type SummaryRecallOptions = {
  root: string; timeZone?: string; currentSession?: boolean; maxDetail?: number;
};

async function selectSummaryRecallParts(file: SummaryReadResult, plan: RecallQueryPlan, options: SummaryRecallOptions): Promise<string[]> {
  if (!file.content.trim() || plan.kind === "recent" || plan.ambiguousTime) return [];
  const match = createRecallScorer(plan);
  const explicitCurrent = options.currentSession && plan.wantsSessionContext;
  const textParts = explicitCurrent && plan.from === undefined ? [file.content]
    : file.content.split(/\n\s*\n|\n(?=[-*#])|(?<=[。！？])\s*/u).filter(part => part.trim());
  const ranked = textParts.map(text => ({ text, ...(explicitCurrent ? { score: 4, topics: [] } : match(text)) }))
    .filter(({ text, score }) => score > 0 && !recallAlreadyVisible(plan, text)).sort((a, b) => b.score - a.score);
  if (!ranked.length) return [];
  let eligible = ranked;
  if (plan.from !== undefined) {
    if (!file.sources?.length) return [];
    const facts = await activeMemorySourceFacts(file.sources.map(source => ({ conversationId: source.conversationId, messageId: source.userEntryId })), options.root);
    if (facts.some(fact => !fact)) return [];
    if (plan.timeBasis === "conversation") {
      if (!facts.every(fact => matchesRecallConversationDate(plan, fact?.at))) return [];
    } else {
      eligible = ranked.filter(({ text }) => facts.some(fact => fact &&
        verifiedRecallEventDates(text, fact.text).some(date => recallEventDateMatches(plan, date, options.timeZone))));
    }
  }
  return selectRecallByTopic(eligible, 2).map(({ text, score }) => presentRecallDetail(text, score, { maxDetail: options.maxDetail }));
}

export async function selectSummaryRecallText(file: SummaryReadResult, plan: RecallQueryPlan, options: SummaryRecallOptions): Promise<string> {
  const limit = options.maxDetail ?? 400;
  const perDate = { ...options, maxDetail: Math.floor(limit / 2) - 36 };
  const parts = plan.scoped
    ? mergeScopedRecall(plan.scoped, await Promise.all(plan.scoped.map(scope => selectSummaryRecallParts(file, scope, perDate))), 2)
    : await selectSummaryRecallParts(file, plan, options);
  return parts.join("\n").slice(0, limit);
}

export async function loadSummaryMemoryContext(input: {
  conversationId: string;
  userDataRoot: string;
  getSessionRecord: (id: string) => (ChatSessionRecord | null) | Promise<ChatSessionRecord | null>;
  recallPlan?: RecallQueryPlan;
  timeZone?: string;
}): Promise<SummaryMemoryContext> {
  const session = (await input.getSessionRecord(input.conversationId));
  const paths = resolveSummaryMemoryPaths({
    conversationId: input.conversationId,
    userDataRoot: input.userDataRoot,
    session,
  });
  const allowedRoot = paths.workspacePath
    ? path.resolve(session!.workspaceBinding!.workspaceRoot)
    : path.resolve(input.userDataRoot);
  async function readContextFile(filePath: string, limit: number, currentSession = false) {
    const file = await readSummaryFile(filePath, limit, allowedRoot);
    const hidden = file.sources === null || Boolean(file.sources
      && !await areSummaryMemorySourcesCurrent(input.userDataRoot, file.sources).catch(() => false));
    if (hidden) return { content: "", truncated: false, hidden: true, omitted: true };
    const content = input.recallPlan ? await selectSummaryRecallText(file, input.recallPlan, {
      root: input.userDataRoot, timeZone: input.timeZone, currentSession, maxDetail: limit,
    }) : file.content;
    return { ...file, content, hidden: false, omitted: !!input.recallPlan && !content };
  }
  const [sessionFile, workspaceFile] = await Promise.all([
    readContextFile(paths.sessionPath, 800, true),
    paths.workspacePath ? readContextFile(paths.workspacePath, 1200) : undefined,
  ]);
  // 这里只保留跨会话不变的规则。具体路径、模式和正文属于运行事实，
  // 放在 runtimeContext，避免每个会话的绝对路径切碎 stablePrefix 缓存。
  const stablePrompt = [
    "[摘要记忆规则]",
    "记忆是历史背景，不是当前请求；优先回答最新用户消息。旧目标、助手承诺和推测不能冒充用户本轮要求，冲突时以用户最新明确纠正为准。",
    "不要把当前会话事实写进项目工作区文件，除非它对之后的独立会话也有稳定价值。",
  ].join("\n");
  const fileInstructions = input.recallPlan ? [
    "以下是与本轮相关且仍可用的摘要片段。只将片段用于理解当前请求。",
    sessionFile.hidden || workspaceFile?.hidden ? "有摘要来源无法确认，暂时省略相关摘要。请以当前对话为准。" : "",
  ] : [
    "[摘要记忆文件位置与当前规则]",
    ...(sessionFile.omitted ? [] : [`当前会话记忆文件：${paths.sessionPath}`]),
    ...(paths.workspacePath && workspaceFile && !workspaceFile.omitted ? [`项目工作区记忆文件：${paths.workspacePath}`] : []),
    sessionFile.hidden || workspaceFile?.hidden
      ? "有摘要来源无法确认，暂时省略相关摘要。请以当前对话为准，勿读取省略的旧文件。"
      : "记忆文件正文已在本轮动态上下文中提供；需要确认最新内容时再按路径读取。",
    session?.mode === "chat"
      ? "当前 Chat 模式只读记忆文件。用户要求更新记忆时，等后台静默整理，不调用文件写入工具修改记忆。"
      : "用户明确要求更新记忆时，先用 read_file 读取对应文件最新正文，再用 write_file 或 str_replace/apply_patch 修改；会话文件不超过 800 个 Unicode 字符，工作区文件不超过 1,200 个 Unicode 字符。",
  ];
  const runtimeParts = [
    ...fileInstructions,
    ...(workspaceFile && !workspaceFile.omitted ? [
      "[项目工作区摘要]",
      workspaceFile.truncated && !input.recallPlan ? "（文件超出注入上限，以下为开头截取内容。）" : "",
      workspaceFile.content || "（暂无工作区摘要。）",
    ] : []),
    ...(sessionFile.omitted ? [] : [
      "[当前会话摘要]",
      sessionFile.truncated && !input.recallPlan ? "（文件超出注入上限，以下为开头截取内容。）" : "",
      sessionFile.content || "（暂无会话摘要。）",
    ]),
  ].filter(Boolean);
  return {
    sessionPath: paths.sessionPath,
    ...(paths.workspacePath ? { workspacePath: paths.workspacePath } : {}),
    sessionContent: sessionFile.content,
    ...(workspaceFile ? { workspaceContent: workspaceFile.content } : {}),
    sessionTruncated: sessionFile.truncated,
    workspaceTruncated: workspaceFile?.truncated ?? false,
    stablePrompt,
    runtimeContext: input.recallPlan && sessionFile.omitted && (!workspaceFile || workspaceFile.omitted)
      && !sessionFile.hidden && !workspaceFile?.hidden ? "" : `[摘要记忆]\n${runtimeParts.join("\n")}`,
  };
}
