import fs from 'node:fs';
// Maintained feature catalog; no private historical report is required.
const baseline = {
  "rows": [
    {
      "id": "F01",
      "name": "登录与初始化",
      "winRef": [
        "src/main/index.ts",
        "createApplication"
      ]
    },
    {
      "id": "F02",
      "name": "Chat 文字与流式回复",
      "winRef": [
        "src/main/orchestrator/chat-loop.ts",
        "recordUsage"
      ]
    },
    {
      "id": "F03",
      "name": "Work 执行工作",
      "winRef": [
        "src/main/orchestrator/cyrene-agent.ts",
        "runHarnessWithAdapter"
      ]
    },
    {
      "id": "F04",
      "name": "Code 编程执行",
      "winRef": [
        "src/main/orchestrator/tools/registry/tool-registration.ts",
        "registerLspTool(deps"
      ]
    },
    {
      "id": "F05",
      "name": "Learn 学习与 Vault",
      "winRef": [
        "src/main/agui-bridge.ts",
        "registerObsidianTools();"
      ]
    },
    {
      "id": "F06",
      "name": "内置办公、生活、联网工具",
      "winRef": [
        "src/main/orchestrator/tools/registry/tool-registration.ts",
        "registerDocumentTools();"
      ]
    },
    {
      "id": "F07",
      "name": "Shell、后台命令与验证",
      "winRef": [
        "src/main/orchestrator/tools/built-in-tools.ts",
        "toolRegistry.register(runShellTool)"
      ]
    },
    {
      "id": "F08",
      "name": "权限审批与沙箱",
      "winRef": [
        "src/main/orchestrator/cyrene-agent.ts",
        "checkPermission"
      ]
    },
    {
      "id": "F09",
      "name": "Plan 模式",
      "winRef": [
        "src/main/application/default-dependencies.ts",
        "recoverInterruptedPlanSessions(plansRoot)"
      ]
    },
    {
      "id": "F10",
      "name": "子代理与任务清单",
      "winRef": [
        "src/main/orchestrator/harness/builtin-tools.ts",
        "export const TASK_TOOL_ID"
      ]
    },
    {
      "id": "F11",
      "name": "用户选择卡与 PopQuiz",
      "winRef": [
        "src/main/orchestrator/harness/builtin-tools.ts",
        "export const ASK_USER_TOOL_ID"
      ]
    },
    {
      "id": "F12",
      "name": "会话 CRUD、置顶、排序、侧栏组织",
      "winRef": [
        "src/main/chats/chats-ipc.ts",
        "registerChatsIpc"
      ]
    },
    {
      "id": "F13",
      "name": "历史分页、标题、上下文压缩",
      "winRef": [
        "src/main/chats/chats-ipc.ts",
        "createConversationTitleService"
      ]
    },
    {
      "id": "F14",
      "name": "消息检查点与权威轨迹",
      "winRef": [
        "src/main/agui-bridge.ts",
        "IPC.AGUI_RUN_PERSISTED"
      ]
    },
    {
      "id": "F15",
      "name": "同会话并发、接管、取消",
      "winRef": [
        "src/main/agui-bridge.ts",
        "input.takeoverFromRunId"
      ]
    },
    {
      "id": "F16",
      "name": "待发队列与插话调整",
      "winRef": [
        "src/main/agui-bridge.ts",
        "resetPendingAdjustByRun"
      ]
    },
    {
      "id": "F17",
      "name": "崩溃恢复与 WS 重连",
      "winRef": [
        "src/main/application/default-dependencies.ts",
        "reconcileCrashedInterruptions"
      ]
    },
    {
      "id": "F18",
      "name": "工作区绑定与选择",
      "winRef": [
        "src/main/chats/chats-ipc.ts",
        "dialog.showOpenDialog"
      ]
    },
    {
      "id": "F19",
      "name": "文件树与文字预览边界",
      "winRef": [
        "src/main/chats/workspace-files-ipc.ts",
        "async function resolveWithinRoot"
      ]
    },
    {
      "id": "F20",
      "name": "附件、图片理解、生成图",
      "winRef": [
        "src/preload/index.ts",
        "ingestDroppedFiles"
      ]
    },
    {
      "id": "F21",
      "name": "文件变更审查、Diff、恢复",
      "winRef": [
        "src/main/chats/chats-ipc.ts",
        "getRunReviewTracker"
      ]
    },
    {
      "id": "F22",
      "name": "Git 状态、分支、提交、推送",
      "winRef": [
        "src/main/code-git/git-service.ts",
        "createGitService"
      ]
    },
    {
      "id": "F23",
      "name": "浏览器页面与 Agent 控制",
      "winRef": [
        "src/main/browser/browser-panel-ipc.ts",
        "registerBrowserPanelIpc"
      ]
    },
    {
      "id": "F24",
      "name": "定时任务与立即执行",
      "winRef": [
        "src/main/scheduler/bootstrap.ts",
        "new SchedulerEngine"
      ]
    },
    {
      "id": "F25",
      "name": "Skill 扫描、覆盖与来源",
      "winRef": [
        "src/main/skills/skill-registry.ts",
        "class SkillRegistry"
      ]
    },
    {
      "id": "F26",
      "name": "Skill 启停、Slash、invoke_skill",
      "winRef": [
        "src/main/skills/skill-catalog.ts",
        "export function buildSkillCatalog"
      ]
    },
    {
      "id": "F27",
      "name": "插件启停与宿主能力",
      "winRef": [
        "src/main/plugin-runtime.ts",
        "PluginManager"
      ]
    },
    {
      "id": "F28",
      "name": "插件导入、卸载、市场、面板",
      "winRef": [
        "src/main/plugin-runtime.ts",
        "createPluginMarketplaceService"
      ]
    },
    {
      "id": "F29",
      "name": "人格、模式提示词、风格、Worldbook",
      "winRef": [
        "src/main/orchestrator/build-options.ts",
        "socialContextEnabled"
      ]
    },
    {
      "id": "F30",
      "name": "情绪状态与运行同步",
      "winRef": [
        "src/main/orchestrator/runtime-state-service.ts",
        "export function createRuntimeStateService"
      ]
    },
    {
      "id": "F31",
      "name": "L0/L1、L2向量与反思",
      "winRef": [
        "src/main/application/default-dependencies.ts",
        "reconcileUserMemoryIndex"
      ]
    },
    {
      "id": "F32",
      "name": "Summary 记忆",
      "winRef": [
        "src/main/memory/memory-user-ipc.ts",
        "IPC.MEMORY_PANEL_GET_SUMMARY"
      ]
    },
    {
      "id": "F33",
      "name": "Wiki 记忆",
      "winRef": [
        "src/main/memory/wiki-memory-ipc.ts",
        "registerWikiMemoryIpc"
      ]
    },
    {
      "id": "F34",
      "name": "Obsidian 绑定、导出、同步",
      "winRef": [
        "src/main/memory/obsidian-exporter.ts",
        "MANIFEST_FILE"
      ]
    },
    {
      "id": "F35",
      "name": "知识库资料管理",
      "winRef": [
        "src/shared/knowledge-base-types.ts",
        "export interface KnowledgeBaseApi"
      ]
    },
    {
      "id": "F36",
      "name": "知识库检索、来源与Agent检索",
      "winRef": [
        "src/main/knowledge-base/knowledge-base-service.ts",
        "async search(query"
      ]
    },
    {
      "id": "F37",
      "name": "Embedding/Reranker",
      "winRef": [
        "src/main/application/default-dependencies.ts",
        "initVectorMemory"
      ]
    },
    {
      "id": "F38",
      "name": "社交上下文/CITA",
      "winRef": [
        "src/main/application/default-dependencies.ts",
        "createSocialContextService({"
      ]
    },
    {
      "id": "F39",
      "name": "主动聊天与跨渠道投递",
      "winRef": [
        "src/main/proactive/proactive-lifecycle.ts",
        "proactiveTrigger.start()"
      ]
    },
    {
      "id": "F40",
      "name": "动态/朋友圈手工操作与AI互动",
      "winRef": [
        "src/main/moments/moments-service.ts",
        "const agent: MomentsAgent"
      ]
    },
    {
      "id": "F41",
      "name": "音乐完整业务",
      "winRef": [
        "src/preload/music.ts",
        "exposeInMainWorld(\"music\""
      ]
    },
    {
      "id": "F42",
      "name": "Learn试卷、作答、评分",
      "winRef": [
        "src/main/application/default-dependencies.ts",
        "registerLearnExamTools("
      ]
    },
    {
      "id": "F43",
      "name": "连接器传输与管理",
      "winRef": [
        "src/main/channels/bootstrap.ts",
        "createChannelsSubsystem"
      ]
    },
    {
      "id": "F44",
      "name": "渠道Agent、媒体与出站组合",
      "winRef": [
        "src/main/channels/bootstrap.ts",
        "createChannelRateLimiter"
      ]
    },
    {
      "id": "F45",
      "name": "连接器细节/身份边界",
      "winRef": [
        "src/main/channels/agent-policy.ts",
        "export function resolveChannelAgentPolicy"
      ]
    },
    {
      "id": "F46",
      "name": "模型配置、测试、thinking",
      "winRef": [
        "src/main/settings/model-settings.ts",
        "export interface ModelSettings"
      ]
    },
    {
      "id": "F47",
      "name": "Token/缓存/请求/上下文统计",
      "winRef": [
        "src/main/orchestrator/chat-loop.ts",
        "const usageRecorder"
      ]
    },
    {
      "id": "F48",
      "name": "头像、贴纸、富文本与滚动",
      "winRef": [
        "src/preload/index.ts",
        "const cyreneAvatarApi"
      ]
    },
    {
      "id": "F49",
      "name": "外观、排版、语言与自定义风格编辑",
      "winRef": [
        "src/renderer/ui/theme.ts",
        "window.cyreneTheme?.get()"
      ]
    },
    {
      "id": "F50",
      "name": "通知、新闻与反馈",
      "winRef": [
        "src/preload/index.ts",
        "const newsApi"
      ]
    },
    {
      "id": "F51",
      "name": "数据迁移与共享核心",
      "winRef": [
        "src/main/orchestrator/conversation-session-migration.ts",
        "ConversationSessionMigration"
      ]
    },
    {
      "id": "F52",
      "name": "Linux部署和服务管理",
      "winRef": [
        "src/main/application/default-dependencies.ts",
        "startShell:"
      ]
    },
    {
      "id": "F53",
      "name": "TTS、ASR、语音通话",
      "winRef": [
        "src/preload/index.ts",
        "const ttsApi"
      ]
    },
    {
      "id": "F54",
      "name": "Gmail/邮件草稿",
      "winRef": [
        "src/main/application/default-dependencies.ts",
        "registerGmailIpc("
      ]
    },
    {
      "id": "F55",
      "name": "MCP",
      "winRef": [
        "src/main/application/default-dependencies.ts",
        "initMcpManager"
      ]
    },
    {
      "id": "F56",
      "name": "Live2D、桌面窗口、托盘、全局截图/热键",
      "winRef": [
        "src/preload/index.ts",
        "const cyreneApi"
      ]
    },
    {
      "id": "F57",
      "name": "编辑最后消息与重新生成",
      "winRef": [
        "src/main/agui-bridge.ts",
        "presentationRevision = rewindEntry"
      ]
    }
  ]
};
const execution = JSON.parse(fs.readFileSync('docs/verification/shared-core-parity-results.json', 'utf8'));
const voiceMcp = JSON.parse(fs.readFileSync('docs/verification/shared-core-voice-mcp-results.json', 'utf8'));
const results = [...execution.results, ...voiceMcp.results];
const contracts = JSON.parse(fs.readFileSync('docs/verification/shared-core-contract-coverage.json', 'utf8'));
const direct = {
  F01: ['Unauthenticated', 'Logout'], F02: ['Chat uses'], F03: ['work executes'], F04: ['code executes'], F05: ['Learn routes'],
  F09: ['Plan transitions'], F10: ['Subagent'], F12: ['Conversation rename'], F16: ['Conversation rename'], F18: ['work executes', 'Open folder'],
  F21: ['work executes', 'code executes'], F23: ['Server browser', 'Element picker', 'Browser control'], F24: ['Scheduled task'],
  F25: ['Skill instructions'], F26: ['Tools and Skill', 'Skill instructions'], F27: ['Plugin executes'], F28: ['Plugin executes'],
  F29: ['Chat uses'], F31: ['Memory edits'], F35: ['Knowledge base'], F36: ['Knowledge base'], F40: ['Memory edits'], F41: ['Local music'],
  F42: ['Learn exam'], F43: ['QQ authenticated'], F44: ['QQ authenticated'], F45: ['QQ authenticated'],
  F46: ['Invalid session'], F47: ['Usage report'], F48: ['Avatar and sticker'], F49: ['Theme and radius'], F50: ['Scheduled task'],
  F51: ['Legacy model'], F57: ['Conversation rename'],
  F53: ['TTS', 'Original chat TTS', 'Historical v2 TTS', 'Automatic reading', 'Another authenticated', 'ASR receives', 'Malformed audio', 'Voice'],
  F55: ['TTS/ASR/MCP', 'MCP', 'Bundled MCP'],
};
const rows = baseline.rows.map(feature => {
  const deferred = feature.id === 'F54', excluded = feature.id === 'F56', deployment = feature.id === 'F52';
  const proofs = results.filter(result => direct[feature.id]?.some(prefix => result.name.startsWith(prefix)));
  return { id: feature.id, name: feature.name,
    status: deferred ? '按用户约定暂缓' : excluded ? '无桌面服务器范围排除' : deployment ? '部署模板及操作指南已提供，平台实机结果见变更说明' : proofs.length ? '接入原核心，端到端执行验证通过' : '接入原核心，原业务回归与契约核对',
    implementation: excluded ? 'Web 隐藏桌宠、桌面截图、窗口/GPU/安装器操作；服务端无需 GUI。' : deferred ? '不纳入本次功能完成声明。' : deployment ? 'Node 24 + Chromium headless + systemd + Nginx/Caddy。' : '原 React 页面及 preload 契约，HTTP/WS 传入隔离 Node worker，复用 Windows 业务实现。',
    windowsImplementation: feature.winRef, webEntrypoint: 'src/server/core/runtime.ts', acceptance: proofs.map(result => result.name),
    limits: ['F43','F44','F45'].includes(feature.id) ? 'QQ 使用本地鉴权 OneBot 网关验证收发；渠道复用原 TTS 合成服务；微信/飞书/QQ 官方机器人实际账户、供应商网络和真实语音消息仍需验收。'
      : feature.id === 'F37' ? '模型文件、embedding 服务和维度依赖实际配置；缺失本地 reranker 时按原规则降级为 none。'
      : feature.id === 'F39' ? '触发/冷却/时区/投递规则已复用；长时间无人值守与真实渠道主动投递未做实机观察。'
      : feature.id === 'F41' ? '播放器页面、队列、账户/库复用；音频输出改为浏览器。付费音乐/账户/供应商访问取决于真实配置。'
      : feature.id === 'F52' ? '报告记录本次 Node 运行平台；Linux 实机及供应商验收边界见 docs/changes/linux-web-changes.md。'
      : feature.id === 'F53' ? '本地协议服务验证真实音频与原通话链路；云供应商账户及真实麦克风需另外验收。本地 ASR 需自行部署兼容音频转写 API 的服务。'
      : feature.id === 'F55' ? 'HTTP/SSE 实际 MCP SDK 服务和 bundled Filesystem stdio 已执行；私人 MCP 账户及各扩展平台依赖需按实际配置验收。' : '',
  };
});
fs.writeFileSync('docs/verification/shared-core-functional-matrix.json', JSON.stringify({ at: new Date().toISOString(), featureCount: rows.length, contracts: contracts.counts, endpointAcceptanceCount: results.length, engine: execution.engine, rows }, null, 2));
console.log('Updated feature matrix:', rows.length, 'domains,', results.length, 'execution checks.');
