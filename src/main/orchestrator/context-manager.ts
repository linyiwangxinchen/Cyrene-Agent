import type { ChatVendorAdapter, ChatMessage, ChatRequest, ModelMessageOrigin, OpenAIContentBlock } from "./vendors/types";
import type { AgentLoopSettings } from "./cyrene-agent";
import { generateChatWithAiSdk, streamChatWithAiSdk } from "./vendors/model-runtime";
import { getTimeoutSettings } from "../timeout-manager";
import { projectModelHistory, recoverPortableMessage } from "./vendors/model-history";
import { AgentRuntimeError } from "./agent-runtime-error";
import { recordRequest, recordUsage } from "../token-usage-store";
import { setTimeout as sleep } from "node:timers/promises";
import { isModelFailureInfo } from "../../shared/model-error";
import { createTranscriptCompactionRequiredError } from "../../shared/transcript-compaction-error";
import { nextModelRetryDelayMs, readRetryAfterMs } from "./vendors/model-retry-policy";

const COMPRESSION_PROMPT = `你正在帮"昔涟"整理对话记忆。请把下面这段较早的对话历史总结成一段简洁的摘要，供后续回复参考。

要求：
1. 保留用户的核心目标、当前任务、未完成的待办事项。
2. 保留用户明确表达过的偏好、禁忌、格式要求。
3. 保留已确认的事实和数据（如路径、文件名、参数值）。
4. 删除具体的寒暄、重复确认、过渡性语句。
5. 如果对话中包含代码/命令，只保留最终生效的版本和用途说明，不保留中间试错。
6. 摘要控制在 400~600 字以内，用中文输出。

对话历史：
{history}

请直接输出摘要内容，不要加任何前缀说明。`;

/** 简单 token 估算：中文字符按 1 token / 1.5 字符，英文按 4 字符 / token。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let nonAscii = 0;
  let ascii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) > 127) nonAscii++;
    else ascii++;
  }
  return Math.ceil(nonAscii / 1.5 + ascii / 4);
}

/**
 * 保守固定回退值。协议 ≠ tokenizer：MiniMax 模型走 Anthropic 协议并不会因此
 * 使用 Claude 的视觉计费算法，故不绑定任何厂商公式。
 * 现实区间：主流多模态模型单图 1k~5k token；取 4096 保守偏高——
 * 压缩安全判定宁可高估，不可低估撞穿 context window。
 */
export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 4096;

/**
 * 图片块不计 base64 字符串（按 DEFAULT_IMAGE_TOKEN_ESTIMATE 估算），text 块照常估算。
 * estimateMessageTokens 与 buildContextUsageSnapshot 共用此函数，防止计量与
 * 压缩判定口径分裂（见 docs/design/2026-08-26-image-context-screenshot-known-issues.md 问题 2）。
 */
export function estimateMessageContentTokens(
  content: string | OpenAIContentBlock[],
): number {
  if (typeof content === "string") return estimateTokens(content);
  let sum = 0;
  for (const block of content) {
    if (block.type === "text") sum += estimateTokens(block.text);
    else sum += DEFAULT_IMAGE_TOKEN_ESTIMATE; // image_url 块
  }
  return sum;
}

/**
 * 按请求投影计量 assistant，而不是累加展示用 thinking / rawAssistant / replay 副本。
 * target 缺省时只计可移植内容；运行时须传当前模型来源，才能计入实际重放的私有块。
 * 仍是粗略估算，不是厂商 tokenizer；图片保持固定估算，不累计 base64。
 */
export function estimateSingleMessageTokens(message: ChatMessage, target?: ModelMessageOrigin): number {
  if (message.role !== "assistant") {
    return estimateMessageContentTokens(message.content ?? "") + 4;
  }
  let projected: ReturnType<typeof projectModelHistory>;
  try {
    projected = projectModelHistory([message], target);
  } catch (error) {
    if (!(error instanceof AgentRuntimeError) || error.code !== "E_MODEL_RESPONSE_PARSE_FAILED") throw error;
    // 损坏的持久化工具参数不能阻断预算/快照。仅粗估便携语义与原始参数，
    // 不解析参数、不重放私有副本，也不修改历史；真实请求投影仍严格报错。
    const portable = recoverPortableMessage(message);
    const imageDescriptions = (portable.attachments ?? [])
      .filter(attachment => attachment.kind === "image" && attachment.source === "model")
      .map(image => `已生成图片：${image.name}`);
    return 4 + estimateMessageContentTokens(portable.content ?? "")
      + estimateTokens(imageDescriptions.join("\n"))
      + (portable.toolCalls ?? []).reduce((sum, call) =>
        sum + estimateTokens(call.id + call.name + call.arguments), 0);
  }
  return projected.reduce((sum, entry) => {
    if (typeof entry.content === "string") return sum + estimateTokens(entry.content) + 4;
    return sum + 4 + entry.content.reduce((total, part) => {
      let tokens = 0;
      if (part.type === "text" || part.type === "reasoning") tokens = estimateTokens(part.text);
      else if (part.type === "tool-call") {
        tokens = estimateTokens(part.toolCallId + part.toolName + JSON.stringify(part.input));
      } else if (part.type === "file" || part.type === "image" || part.type === "reasoning-file") tokens = DEFAULT_IMAGE_TOKEN_ESTIMATE;
      else return total + estimateTokens(JSON.stringify(part));
      // 签名/加密 reasoning 等私有数据也会随有效重放发送；只估算，不记录内容。
      if ("providerOptions" in part && part.providerOptions) tokens += estimateTokens(JSON.stringify(part.providerOptions));
      return total + tokens;
    }, 0);
  }, 0);
}

export function estimateMessageTokens(messages: ChatMessage[], target?: ModelMessageOrigin): number {
  return messages.reduce((sum, message) => sum + estimateSingleMessageTokens(message, target), 0);
}

function withoutImageData(text: string): string {
  return text.replace(/data:image\/[^\s;,"'<>]+;base64,[A-Za-z0-9+/=_-]+/g, "[图片编码省略，原图保留在会话附件中]");
}

/** 摘要只消费可移植语义；图片保留引用，不把编码当成数十万 token 的正文。 */
function formatConversation(messages: ChatMessage[]): string {
  return messages
    .map(recoverPortableMessage)
    .map((m) => {
      const prefix = m.role === "user" ? "用户" : m.role === "assistant" ? "昔涟" : m.role;
      const text = typeof m.content === "string" ? m.content : (m.content ?? []).map(block =>
        block.type === "text" ? block.text : "[图片：内容由原会话及附件引用保留，不从编码推断图像细节]").join("\n");
      const calls = (m.toolCalls ?? []).map(call => `工具调用 ${call.name}（${call.id}）：${call.arguments}`);
      const result = m.role === "tool" ? `工具结果 ${m.name ?? ""}（${m.toolCallId ?? ""}）` : "";
      const files = [...(m.userAttachments ?? []), ...(m.attachments ?? [])]
        .map(file => `附件 ${file.name}：${file.filePath}`);
      return withoutImageData(`--- ${prefix} ---\n${[result, text, ...calls, ...files].filter(Boolean).join("\n")}`);
    })
    .join("\n\n");
}

/** 单条超长工具输出也可分片；按同一 token 口径遍历，不截掉历史尾部。 */
function splitSummaryInput(text: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  const maxUnits = maxTokens * 12;
  let start = 0;
  let offset = 0;
  let units = 0;
  for (const char of text) {
    const weight = char.charCodeAt(0) > 127 ? 8 : 3;
    if (units + weight > maxUnits && offset > start) {
      chunks.push(text.slice(start, offset));
      start = offset;
      units = 0;
    }
    units += weight;
    offset += char.length;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

function retryableSummaryFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = (error as { modelFailure?: unknown }).modelFailure;
  if (!isModelFailureInfo(failure)) return false;
  if (failure.retryable === false) return false;
  return ["RATE_LIMIT", "TIMEOUT", "NETWORK", "OVERLOADED", "SERVER_ERROR", "UNAVAILABLE"].includes(failure.category)
    || failure.status === 408 || failure.status === 429 || (failure.status !== undefined && failure.status >= 500);
}

/**
 * 独立的 LLM 摘要调用：把一段历史消息摘要成文本。
 * Chat 模式循环内压缩与「主动压缩」IPC（chats:compact）共用；失败直接 throw，由调用方决定兜底。
 */
export async function callSummarizeModel(
  messages: ChatMessage[],
  adapter: ChatVendorAdapter,
  settings: AgentLoopSettings,
  signal?: AbortSignal,
): Promise<string> {
  const vendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    responsesNative: settings.responsesNative,
    reasoning: settings.reasoning,
    manualReasoning: settings.manualReasoning,
  };

  const contextWindow = settings.contextWindowTokens ?? 256_000;
  // 输出预留包含推理 token。限制每次摘要输入，避免长历史在临近窗口上限时再次溢出。
  const maxTokens = Math.min(16_384, Math.max(256, Math.floor(contextWindow * 0.2)));
  const safetyMargin = Math.min(1024, Math.max(64, Math.floor(contextWindow * 0.05)));
  const instruction = "请总结上面的对话历史。保留本段里的精确事实；如果是分段摘要，合并已有摘要。";
  const overhead = estimateTokens(COMPRESSION_PROMPT.replace("{history}", "")) + estimateTokens(instruction) + 16;
  const inputBudget = Math.min(48_000, Math.floor(contextWindow - maxTokens - safetyMargin - overhead));
  if (!Number.isFinite(inputBudget) || inputBudget < 1) {
    throw createTranscriptCompactionRequiredError(undefined, "no_safe_boundary");
  }

  const summarizeChunk = async (history: string): Promise<string> => {
    // 与正常 Responses 聊天使用同一流式通道，在本地收集完整摘要。
    // Codex 兼容中转可能仅接受 stream:true，或始终返回 SSE，不能交给 JSON-only generateText。
    const streaming = adapter.transport === "responses";
    const request: ChatRequest = {
      model: settings.model,
      messages: [
        { role: "system", content: COMPRESSION_PROMPT.replace("{history}", () => history) },
        { role: "user", content: instruction },
      ],
      maxTokens,
      stream: streaming,
    };
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let parsed;
      try {
        const runSummary = streaming ? streamChatWithAiSdk : generateChatWithAiSdk;
        parsed = await runSummary({ adapter, request, config: vendorConfig,
          signal, timeoutMs: getTimeoutSettings().chatRequestTimeout });
      } catch (error) {
        if (signal?.aborted || attempt >= 2 || !retryableSummaryFailure(error)) throw error;
        const delay = nextModelRetryDelayMs(attempt + 1, readRetryAfterMs(error));
        if (delay === undefined) throw error;
        await sleep(delay, undefined, { signal });
        continue;
      }
      recordRequest(settings.model);
      if (parsed.usage) {
        recordUsage(parsed.usage.input, parsed.usage.output, 1, parsed.usage.cachedInput, settings.model, parsed.usage.cacheCreation);
      }
      // 空正文/仅推理/拒答/截断不能成为可持久化的摘要，更不能归档掉原记录。
      const summary = parsed.text.trim();
      if (!summary || parsed.refusal || ["length", "max_tokens", "content_filter"].includes(parsed.finishReason)) {
        throw createTranscriptCompactionRequiredError(undefined, "invalid_summary");
      }
      return summary;
    }
  };

  let history = formatConversation(messages);
  if (!history.trim()) throw createTranscriptCompactionRequiredError(undefined, "invalid_summary");
  // 先逐片摘要，再合并为一个检查点；任意片失败都会保留整段原轨迹供重试。
  for (let level = 0; level < 8; level++) {
    const chunks = splitSummaryInput(history, inputBudget);
    if (chunks.length === 1) return summarizeChunk(chunks[0]!);
    const summaries: string[] = [];
    for (const chunk of chunks) summaries.push(await summarizeChunk(chunk));
    const reduced = summaries.map((summary, index) => `【第 ${index + 1} 段摘要】\n${summary}`).join("\n\n");
    if (estimateTokens(reduced) >= estimateTokens(history)) {
      throw createTranscriptCompactionRequiredError(undefined, "invalid_summary");
    }
    history = reduced;
  }
  throw createTranscriptCompactionRequiredError(undefined, "invalid_summary");
}
