import type { GeneratedImageAttachment } from "../../shared/generated-image";
import { validateCaptionImagePath } from "../chat/image-caption";
import type { GeneratedImageStore } from "../chats/generated-image-store";
import { generateChatWithAiSdk } from "../orchestrator/vendors/model-runtime";
import { getAdapterForConfig } from "../orchestrator/vendors";
import type { ChatMessage, OpenAIContentBlock, VendorConfig } from "../orchestrator/vendors/types";
import { XILIAN_IMAGE_GENERATION_PROMPT } from "../persona/xilian-image-prompt";
import { XILIAN_REFERENCE_NOTE } from "../persona/xilian-reference-images";
import type { InitiativeOpportunityInput } from "./initiative-opportunities";

export const SELFIE_SOURCE = "selfie";

/** 主动自拍只在白天几个自然的时段：上午晚些、下午、傍晚到晚上。 */
export function selfieSlot(localHour: number): "morning" | "afternoon" | "evening" | undefined {
  if (localHour >= 10 && localHour < 13) return "morning";
  if (localHour >= 15 && localHour < 18) return "afternoon";
  if (localHour >= 19 && localHour < 22) return "evening";
  return undefined;
}

export interface SelfieOpportunityInput {
  now: number;
  localDate: string;
  localHour: number;
  conversationId: string;
  /** 昔涟此刻在做什么、在哪里，来自虚构世界生活快照。 */
  location?: string;
  activity?: string;
}

/** 每个时段最多一个自拍机会；sourceEventId 按日期和时段去重。 */
export function selfieOpportunity(input: SelfieOpportunityInput): InitiativeOpportunityInput | undefined {
  const slot = selfieSlot(input.localHour);
  if (!slot) return undefined;
  const where = [input.location?.trim(), input.activity?.trim()].filter(Boolean).join("，");
  const id = `${SELFIE_SOURCE}:${input.localDate}:${slot}`;
  return {
    id, source: SELFIE_SOURCE, sourceEventId: id, evidenceVersion: slot, conversationId: input.conversationId,
    motive: "interesting",
    summary: `昔涟想随手拍一张自拍发给对方${where ? `（她此刻：${where}）` : ""}。图片会先发出去，这条消息是配图时随口说的一两句：说说拍的时候在干嘛或想到了对方，不描述画面细节。`,
    occurredAt: input.now, expiresAt: input.now + 3 * 3_600_000, strengthPerHour: 2, decayPerHour: 0.3,
    replyBurden: "none", sceneId: id, score: 72, sceneCooldownMs: 0,
  };
}

/** 写配文时附在计划后面，提醒模型照片会先发出去。 */
export const SELFIE_CAPTION_NOTE = "（你刚拍了一张自拍，图片会先发过去。这条是配图时随口说的话，一两句，不描述图片里有什么，也不说“给你发张自拍”这种话。）";

export interface GenerateProactiveSelfieInput {
  config: VendorConfig;
  imageModel: string;
  /** 本次自拍的场景描述（生活快照 + 她想说的事）。 */
  scene: string;
  referencePaths: readonly string[];
  conversationId: string;
  store: Pick<GeneratedImageStore, "save">;
  timeoutMs?: number;
  generate?: typeof generateChatWithAiSdk;
}

export function buildProactiveSelfieMessages(scene: string, referencePaths: readonly string[]): ChatMessage[] {
  const content: OpenAIContentBlock[] = [{ type: "text", text: [
    scene.trim(),
    "调用图片生成工具画出这张自拍。只要图片，不用写文字回复。",
  ].join("\n") }];
  const references: OpenAIContentBlock[] = [];
  for (const filePath of referencePaths) {
    const validated = validateCaptionImagePath(filePath);
    if (!validated.ok) {
      console.warn(`[XilianSelfie] 参考图读取失败 ${filePath}: ${validated.error}`);
      continue;
    }
    references.push({ type: "image_url", image_url: { url: `data:${validated.mime};base64,${validated.buffer.toString("base64")}` } });
  }
  if (references.length) content.push({ type: "text", text: XILIAN_REFERENCE_NOTE }, ...references);
  return [
    { role: "system", content: XILIAN_IMAGE_GENERATION_PROMPT },
    { role: "user", content },
  ];
}

/** 生成一张主动自拍并落盘；没有生成出图片时返回 undefined，调用方放弃这次主动消息。 */
export async function generateProactiveSelfie(input: GenerateProactiveSelfieInput): Promise<GeneratedImageAttachment | undefined> {
  const adapter = getAdapterForConfig(input.config);
  if (adapter.transport !== "responses") return undefined;
  const response = await (input.generate ?? generateChatWithAiSdk)({
    adapter, config: input.config, timeoutMs: input.timeoutMs ?? 180_000,
    request: {
      model: input.config.model,
      messages: buildProactiveSelfieMessages(input.scene, input.referencePaths),
      imageGeneration: { enabled: true, model: input.imageModel, quality: "medium" },
    },
  });
  const image = response.generatedImages?.[0];
  if (!image) return undefined;
  return input.store.save({ conversationId: input.conversationId, image });
}
