import { getAdapterForConfig } from "../main/orchestrator/vendors";
import { generateChatWithAiSdk, streamChatWithAiSdk } from "../main/orchestrator/vendors/model-runtime";
import type { ChatResponse, VendorConfig } from "../main/orchestrator/vendors/types";
import type { UnifiedStreamDelta } from "../main/orchestrator/vendors/sdk-stream/types";
import { alignPresetApiBase } from "../shared/api-endpoint";
import { normalizeReasoningPreference } from "../shared/reasoning";
import { normalizeManualReasoningConfig } from "../shared/manual-reasoning";
import { getCapabilityOrOpenAI } from "../main/orchestrator/vendors/capabilities";
import { normalizeImageGenerationModel } from "../main/orchestrator/vendors/model-factory";
import type { WebStore } from "./web-store";
import { WebPersonaRuntime } from "./web-persona-runtime";
import type { WebMediaStore } from "./web-media-store";
import type { GeneratedImageAttachment } from "../shared/generated-image";
import { isXilianSelfieRequest } from "../main/proactive/xilian-life-context";
import type { RelationshipChannel } from "../main/relationship/relationship-log-core";

const personaRuntimes = new WeakMap<WebStore, WebPersonaRuntime>();
function personaForStore(store: WebStore): WebPersonaRuntime {
  let persona = personaRuntimes.get(store);
  if (!persona) { persona = new WebPersonaRuntime(store.getDataDir()); personaRuntimes.set(store, persona); }
  return persona;
}

export function modelConfig(input: Record<string, unknown>): VendorConfig {
  const provider = typeof input.provider === "string" ? input.provider : "自定义端点";
  const explicitTransport = input.explicitTransport === "anthropic" || input.explicitTransport === "responses" || input.explicitTransport === "openai"
    ? input.explicitTransport : getCapabilityOrOpenAI(provider).transport;
  const baseUrl = alignPresetApiBase(String(input.baseUrl ?? "").trim(), explicitTransport);
  const model = String(input.model ?? "").trim();
  if (!baseUrl || !model) throw new Error("请配置模型服务地址和模型名称");
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("模型服务地址必须是 HTTP 或 HTTPS URL");
  const rawImageGeneration = input.imageGeneration;
  const imageGeneration = rawImageGeneration && typeof rawImageGeneration === "object" && !Array.isArray(rawImageGeneration)
    ? rawImageGeneration as { enabled?: unknown; model?: unknown }
    : undefined;
  const normalizedImageGeneration = typeof imageGeneration?.enabled === "boolean" && typeof imageGeneration.model === "string"
    ? { enabled: imageGeneration.enabled, model: normalizeImageGenerationModel(imageGeneration.model) }
    : undefined;
  return { provider, baseUrl, model, apiKey: String(input.apiKey ?? ""), explicitTransport,
    ...(normalizedImageGeneration ? { imageGeneration: normalizedImageGeneration } : {}),
    ...(typeof input.responsesNative === "boolean" ? { responsesNative: input.responsesNative } : {}),
    reasoning: normalizeReasoningPreference(input.reasoning), manualReasoning: normalizeManualReasoningConfig(input.manualReasoning) };
}

export function modelError(error: unknown, apiKey = ""): string {
  let message = error instanceof Error ? error.message : String(error);
  if (apiKey) message = message.split(apiKey).join("[已隐藏密钥]");
  if (/abort|timeout|超时/i.test(message)) return "模型请求已取消或超时，请检查服务地址、网络和超时设置";
  return message.slice(0, 1000);
}

export async function testModel(input: Record<string, unknown>, timeoutMs: number) {
  const started = Date.now();
  try {
    const config = { ...modelConfig(input), testTimeoutMs: timeoutMs };
    const result = await getAdapterForConfig(config).testConnection(config);
    return { ...result, ...(result.error ? { error: modelError(result.error, config.apiKey) } : {}) };
  } catch (error) { return { ok: false, latency: Date.now() - started, error: modelError(error, String(input.apiKey ?? "")) }; }
}

export async function testVisionModel(input: Record<string, unknown>, timeoutMs: number) {
  const started = Date.now();
  try {
    const config = modelConfig({ ...input, provider: "自定义端点", explicitTransport: "openai" });
    const result = await generateChatWithAiSdk({ adapter: getAdapterForConfig(config), config, timeoutMs, request: {
      model: config.model, messages: [{ role: "user", content: [
        { type: "text", text: "这张图片是什么颜色？请只用一个词回答。" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC" } },
      ] }], stream: false,
    } });
    if (!result.text.trim()) throw new Error("视觉模型返回空回复");
    return { ok: true, latency: Date.now() - started, sample: result.text.slice(0, 80) };
  } catch (error) { return { ok: false, latency: Date.now() - started, error: modelError(error, String(input.apiKey ?? "")) }; }
}

export async function resolveWebModel(store: WebStore, input: { sessionId?: string; modelProfileId?: string; model?: string }) {
  const settings = await store.getSettings();
  const session = input.sessionId ? await store.get(input.sessionId) : null;
  const profile = settings.modelProfiles.find(item => item.id === (session?.modelProfileId ?? input.modelProfileId))
    ?? settings.modelProfiles.find(item => item.id === settings.defaultModelProfileId) ?? settings.modelProfiles[0];
  if (!profile) throw new Error("尚未配置模型，请在模型设置中添加模型后重试");
  const requestedModel = session ? session.model : input.model;
  const selected = typeof requestedModel === "string" && (!Array.isArray(profile.models) || profile.models.includes(requestedModel)) ? requestedModel : profile.model;
  const modelOptions = profile.modelOptions && typeof profile.modelOptions === "object" ? profile.modelOptions as Record<string, Record<string, unknown>> : {};
  const config = modelConfig({ ...profile, model: selected, manualReasoning: modelOptions[String(selected)]?.manualReasoning ?? profile.manualReasoning });
  return { settings, session, profile, config };
}

export async function requestSessionModel(store: WebStore, sessionId: string, prompt: string, options: {
  signal?: AbortSignal; onDelta?: (delta: UnifiedStreamDelta) => void;
  persona?: WebPersonaRuntime; styleId?: unknown; legacyStyle?: unknown; channel?: RelationshipChannel; media?: WebMediaStore;
} = {}): Promise<ChatResponse & { generatedAttachments?: GeneratedImageAttachment[] }> {
  const { settings, session, config } = await resolveWebModel(store, { sessionId });
  if (!session) throw new Error("对话不存在");
  const persona = options.persona ?? personaForStore(store);
  const built = await persona.build({ session, settings, config, prompt, styleId: options.styleId, legacyStyle: options.legacyStyle, channel: options.channel });
  const timeoutMs = Number(settings.timeout.chatRequestTimeout ?? settings.timeout.requestTimeout) || 300_000;
  const request = { model: config.model, messages: built.messages, promptLayers: built.metadata, ...built.sampling, stream: Boolean(options.onDelta),
    ...(config.imageGeneration?.enabled ? { imageGeneration: config.imageGeneration } : {}) };
  try {
    const result = await (options.onDelta ? streamChatWithAiSdk : generateChatWithAiSdk)({
      adapter: getAdapterForConfig(config), config, request, timeoutMs, signal: options.signal, onDelta: options.onDelta,
    });
    if (!result.text.trim() && !result.generatedImages?.length) throw new Error("模型返回了空回复，请检查推理模式与输出 Token 限制");
    const generatedAttachments: GeneratedImageAttachment[] = [];
    for (const image of result.generatedImages ?? []) {
      try {
        if (!options.media) throw new Error("Web 图片存储不可用");
        generatedAttachments.push(await options.media.saveGeneratedImage(image));
      } catch (error) {
        console.warn("[WebMedia] 生成图片保存失败", error instanceof Error ? error.message : "unknown");
      }
    }
    if (isXilianSelfieRequest(prompt) && config.imageGeneration?.enabled && built.worldSnapshot) {
      try {
        const artifact = persona.claimXilianSelfieArtifact(built.worldSnapshot);
        if (artifact) {
          if (generatedAttachments.length > 0) {
            persona.completeXilianSelfieArtifact(artifact.id, {
              imageModel: config.imageGeneration.model,
              outputPath: generatedAttachments[0]?.previewUrl,
            });
          } else {
            persona.failXilianSelfieArtifact(artifact.id, "parse");
          }
        }
      } catch (error) {
        console.warn("[XilianWorld] Web 自拍 artifact 状态写入失败", error);
      }
    }
    if (!options.signal?.aborted && result.text.trim() && settings.config.memoryMode !== "off") {
      // A persistence failure must not turn a successfully generated reply into a runtime error.
      try { await persona.recordTurn(prompt, result.text, options.channel); }
      catch { console.warn("[WebPersona] 无法保存关系线索，请检查数据目录写入权限"); }
    }
    return {
      ...result,
      ...(generatedAttachments.length ? { generatedAttachments } : {}),
      ...(generatedAttachments.length ? { generatedImages: undefined } : {}),
    };
  } catch (error) { throw new Error(modelError(error, config.apiKey)); }
}
