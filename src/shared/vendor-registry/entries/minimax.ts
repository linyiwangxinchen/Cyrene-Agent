// minimax（稀宇科技）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor, legacyMetadata } from "../define-vendor";

export const MINIMAX_REGISTRY = defineVendor({
  capability: {
    id: "minimax",
    displayName: "MiniMax（稀宇科技）",
    // 官方对 M 系列优先推荐 Anthropic SDK；OpenAI 兼容入口仍可由用户显式选择。
    transport: "anthropic",
    baseUrl: "https://api.minimaxi.com/anthropic",
    // OpenAI 兼容入口使用 Bearer；Anthropic 入口由下方 override 使用 x-api-key。
    authStyle: "bearer",
    anthropicAuthStyle: "x-api-key",
    defaultModel: "MiniMax-M3",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "cache_control",
    testStrategy: "text",
    // 视觉仍走 OpenAI 兼容入口。
    visionBaseUrl: "https://api.minimaxi.com/v1",
    // 三协议全支持（协议矩阵 2026-08-21）
    supportedTransports: ["anthropic", "openai", "responses"],
  },
  presetDefaults: {
    baseUrl: "https://api.minimaxi.com/v1",
    transport: "anthropic",
    anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
    responsesBaseUrl: "https://api.minimax.cn/v1",
    visionBaseUrl: "https://api.minimaxi.com/v1",
  },
  models: [
    {
      model: "MiniMax-M3.1-Flash",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "sampling", transport: "anthropic", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "anthropic", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "MiniMax-M3",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "structuredOutput", transport: "anthropic", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "MiniMax-M2.7",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "structuredOutput", transport: "anthropic", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    {
      model: "MiniMax-M2.5",
      recommendedFor: ["chat"],
      unknownCapabilities: [
        { feature: "structuredOutput", transport: "anthropic", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
    // 2026-09-27 的预览版名称（仅 Token Plan / MiniMax Code），正式版发布后不再推荐；
    // 已保存该名称的配置仍按 M3.1 推理规则处理。
    {
      model: "MiniMax-M3.1-Flash-Preview",
      recommendedFor: [],
      note: "历史清单保留名称；不改写用户请求。",
      unknownCapabilities: [
        { feature: "sampling", transport: "anthropic", note: "现有采样白名单未覆盖该型号。" },
        { feature: "structuredOutput", transport: "anthropic", note: "预设协议没有专用结构化输出规则，保留提示词 JSON 回退。" },
      ],
    },
  ],
  shortName: "MiniMax",
  // 厂商怪癖：OpenAI 兼容文本 API 的 tool_choice 文档仅支持 auto/none，
  // must-call 一律首选 auto。
  toolChoiceQuirk: {
    mustCall: { preferred: "auto", when: "always" },
  },
  samplingRules: [
    {

      modelPattern: /^MiniMax-(?:M3|M2\.(?:7|5))$/i,
      diversity: true,
      metadata: legacyMetadata("迁自 src/main/orchestrator/vendors/style-sampling.ts"),
    },
  ],
  structuredOutputRules: [
    {
      id: "minimax-m3-adapter",

      transport: "openai",
      modelPattern: /^MiniMax-M3(?:$|[-_])/i,
      tier: "M",
      mode: "prompt_json",
      verification: "contract_verified",
      requestHints: { sendJsonObject: true, reasoningSplit: true },
      metadata: legacyMetadata("迁自 src/main/orchestrator/structured-output/profiles.ts"),
    },
  ],
  reasoningRules: [
    // ── minimax（稀宇科技）──
    // M3.1-Flash（2026-10-19 正式发布，按量 API 可用；此前 2026-09-27 的 -Preview 仅 Token Plan / MiniMax Code）：
    // 1M 上下文 + 原生多模态。effort 五档 low/medium/high/xhigh/max；思考不能关闭
    // （发送 thinking disabled 或 effort none 返回 400）→ supportsDisable=false。
    // 官方缺省 max，与 GLM-5.3 / Kimi K3 同属"思考爆炸"体质，产品默认压到 high。
    // 官方核验只针对正式型号名，精确匹配；两条规则都必须排在 /^MiniMax-M3/ 之前，否则会被 M3 的 toggle 规则先吞掉。
    { modelPattern: /^MiniMax-M3\.1-Flash$/i, modelInferencePattern: /^MiniMax-M3\.1-Flash$/i, metadata: {
      status: "supported",
      evidence: {
        kind: "official",
        url: "https://platform.minimax.io/docs/guides/text-generation",
        checkedAt: "2026-10-19",
        transports: ["anthropic"],
      },
    }, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: false,
      autoEffort: "high",
    } },
    // 其余 M3.1 名称（含仅 Token Plan 可用的历史名称 -Preview）沿用同一能力，但未按当前文档核验，保留 legacy 元数据。
    { modelPattern: /^MiniMax-M3\.1/i, modelInferencePattern: /^MiniMax-M3\.1/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/minimax.ts"), capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: false,
      autoEffort: "high",
    } },
    // M3 走 anthropic-adaptive（on=adaptive / off=disabled），不用通用 thinking-type 路径。
    { modelPattern: /^MiniMax-M3/i, modelInferencePattern: /^MiniMax-M3/i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/minimax.ts"), capability: {
      control: "toggle",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
      defaultMode: "off",
    } },
    { familyLabel: "MiniMax-M2.x 系列", modelPattern: /^MiniMax-M2\./i, modelInferencePattern: /^MiniMax-M2\./i, metadata: legacyMetadata("迁自 src/shared/vendor-registry/entries/minimax.ts"), capability: {
      control: "fixed-on",
      requestStyle: "none",
      supportsDisable: false,
    } },
  ],
});
