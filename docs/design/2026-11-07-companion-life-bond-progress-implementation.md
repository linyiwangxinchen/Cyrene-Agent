# 陪伴生命周期、羁绊进度与自然消息节奏实现方案

状态：已实现（本地验证通过）

当前进度：Phase 1、Phase 2 和 Phase 3 的核心链路已接入；Bilibili Garden 观察事件、插件分享开关和设置界面已接入；虚拟精力、好奇、无聊、每日预算和低压力提问候选已补齐；全量回归、类型检查和构建已通过。真实第三方账号行为仍属于现场验证范围。

目标：在保留现有关系边界、权限边界、渠道可靠投递和事实披露规则的前提下，增加可持续的羁绊进度、虚拟日常、事件驱动主动消息、长任务过程反馈和自然分段投递。

## 1. 设计结论

现有 `RelationshipState.closeness` 继续表示用户明确设置的相处偏好，不改成按聊天次数自动增长。新增独立的 `BondProgressState` 作为 GalGame 风格的“羁绊/攻略进度”。它只因高置信度的相处事件增加，不因冷淡、暂停、长时间不聊天或普通失败而减少。

关系、情绪、羁绊进度和工具权限保持四个独立领域：

- `RelationshipState`：用户可编辑的称呼、边界、风格、共同目标和关系阶段。
- `AffectState`：短期情绪表达线索，可以自然衰减。
- `BondProgressState`：只增不减的游戏化进度、章节和已解锁里程碑。
- `CompanionPermissions`：工具和外部渠道权限，不能被亲密度或攻略度隐式提升。

## 2. 统一事件链

新增一条内部事件链，统一承载相处进度和主动生活：

```text
会话 / 渠道 / Scheduler / Moments / 插件
             │
             ▼
      CompanionEventNormalizer
             │
       ┌─────┴─────┐
       ▼           ▼
BondProgressLedger  CompanionMomentQueue
       │           │
       │           ▼
       │    ProactiveDecisionGate
       │           │
       └─────┬─────┘
             ▼
      ProactiveIntent
             ▼
      ChannelDeliveryService
             ▼
        Durable Outbox
```

事件必须具备稳定 `eventId`、来源、会话、时间、摘要和可选的证据引用。原始凭证、访问令牌、私密评论全文和插件内部调试数据不能进入事件。

## 3. 数据模型

### 3.1 羁绊进度

新增 `src/shared/companion-progress.ts`：

```ts
interface BondProgressState {
  version: 1;
  score: number;
  chapter: string;
  unlockedMilestones: string[];
  awardedEventIds: string[];
  updatedAt: number;
  revision: number;
}
```

`score` 只允许单调增加。删除关系记录时不自动回退；提供显式“重置羁绊进度”操作，供用户主动清除游戏化状态。

### 3.2 陪伴事件

新增 `src/shared/companion-events.ts`：

```ts
type CompanionEventKind =
  | "turn_completed"
  | "goal_progressed"
  | "followup_completed"
  | "repair_acknowledged"
  | "moment_shared"
  | "plugin_observation"
  | "music_context"
  | "idle_window";

interface CompanionEvent {
  eventId: string;
  kind: CompanionEventKind;
  source: "desktop" | "web" | "channel" | "scheduler" | "plugin" | "system";
  conversationId?: string;
  occurredAt: number;
  summary: string;
  evidenceRefs?: string[];
  pluginId?: string;
  payload?: Record<string, string | number | boolean>;
}
```

### 3.3 虚拟生活候选

新增 `CompanionMoment` 和 `ProactiveIntent`。候选可以是分享、提问、轻量问候、跟进或玩笑，但必须经过当前主动策略、安静时间、未回复数量、渠道可用性和每日预算检查。

`CompanionLifeState` 持久化短期状态：虚拟精力、好奇、无聊、最近互动时间、当天已发消息数、当天已提问数和当天插件分享数。状态只用于候选排序和频率控制，不伪装成现实生理状态，也不参与权限判断。

## 4. 进度奖励规则

奖励不绑定消息数量，使用事件类型和置信度：

- 普通轮次：不直接奖励。
- 明确分享新偏好或共同目标：低到中等奖励。
- 完成共享目标或明确修复边界：较高奖励。
- 插件重复扫描、工具重试、群聊、后台内部轮次：不奖励。
- 明确新增共同目标、共同时刻或昔涟偏好：只奖励一次，重复保存不重复增加。
- 同一 `eventId` 只能奖励一次。
- 每日设置软上限，避免刷消息获得进度。

奖励结果写入进度账本，账本写入和事件去重必须原子完成。

## 5. 长任务消息节奏

渠道运行继续复用现有 `activeRuns`、AbortSignal、`/status`、`/stop` 和 outbox：

1. 生产渠道不自动发送“已收到，开始执行任务”的额外回执。
2. 用户可以通过 `/status` 查询阶段，通过 `/stop` 请求取消。
3. 工具阶段不向用户发送 reasoning 或内部工具名。
4. 最终回答由消息编排器拆成少量语义片段，代码、JSON、URL 和表格保持完整。
5. 每个分片进入 durable outbox，顺序、重启恢复和未知送达语义保持不变。

微信/飞书支持“自然 / 按句 / 关闭”三种分段模式；旧配置保持原行为，用户可以在设置中切换。

## 6. 虚拟每天

新增 `CompanionLifeService`，由事件触发和每日时间窗口共同驱动：

- 早间、白天、晚间和安静时间使用用户时区。
- 维护虚拟精力、好奇、无聊和待分享心事等短期状态。
- 每日限制主动消息和主动提问数量。
- 默认每天最多 8 条主动消息、3 条主动提问、6 条插件观察分享；达到上限后只保留队列，不继续投递。实际投递仍受 2 小时全局冷却、安静时间和未回复保护约束。
- 连续未回复时降低频率并暂停重复追问。
- 用户一段时间没有互动且虚拟无聊值达到阈值时，最多生成一条低压力提问候选。
- `innerLifeEnabled` 产生的内容必须显式属于虚构角色日常，不声称为现实经历。
- 用户暂停关系模拟或主动生活时，候选生成和投递立即停止。

插件只能发布经过 Schema 校验的观察事件，不能直接向用户发送消息。

## 7. 插件观察事件

Bilibili Garden 后续增加 `plugin:bili-garden:interesting-item` 事件。事件只包含：标题、URL、安全短摘录、和用户近期主题的关联理由、扫描水位和插件版本。

宿主负责：

- 过滤凭证、评论者个人信息和内部调试字段。
- 去重和持久化事件。
- 判断是否允许插件主动分享。
- 生成昔涟语气的分享或提问。
- 通过统一渠道 outbox 投递。

## 8. 设置和 UI

新增设置项：

- 羁绊进度显示和重置。
- 虚拟日常开关。
- 主动分享插件观察开关。
- 主动提问开关和每日上限。
- 每日主动消息上限。
- 安静时间和投递目标。
- 渠道自然分段模式。

陪伴设置页增加进度条、章节、已解锁里程碑、最近奖励来源和主动生活状态；奖励来源只显示安全摘要，不展示插件凭证或内部输出。

## 9. 实施阶段

### Phase 1：契约与持久化基础

- 新增 shared 类型、默认值、校验和迁移。
- 为关系存储增加 `bondProgress`、事件去重和显式重置命令。
- 增加纯函数奖励计算器和进度账本。
- 补充重启、重复事件、边界事件和重置测试。

### Phase 2：自然消息节奏

- 为渠道长任务接入软确认和阶段节流。
- 扩展消息分段策略，保护代码/URL/结构化文本。
- 保持 outbox 逐片确认和未知送达不重发。
- 补充快速完成、长任务、取消、重启和分片顺序测试。

### Phase 3：虚拟生活与事件队列

- 新增 CompanionEventNormalizer、CompanionMomentQueue 和 CompanionLifeService。
- 将现有主动策略作为统一决策闸门。
- 接入 turn、followup、moments、scheduler 和插件观察事件。
- 持久化虚拟精力、好奇、无聊和每日预算，接入用户互动、插件观察与成功分享后的状态变化。
- 增加每日预算、未回复保护、安静时间和虚构披露测试。

### Phase 4：插件事件和 Bilibili 观察

- 扩展 Plugin API 的结构化宿主事件契约。
- Bilibili Garden 发布安全观察事件。
- 宿主完成脱敏、去重、入队和渠道投递。
- 覆盖插件离线、扫描失败、重复水位和敏感字段过滤。

### Phase 5：UI、文案和迁移收尾

- 陪伴设置页进度和生活控制面板。
- 中文、英文、日文文案补齐。
- 默认配置保持保守：虚拟生活和插件主动分享默认关闭；自然分段可按渠道开启。
- 完成全量类型检查、Vitest、Web 构建和 headless 构建。

## 10. 不变量

- 羁绊进度不会因为沉默、暂停或普通失败下降。
- 关系进度绝不改变工具和文件权限。
- 事件、奖励、主动意图和 outbox 都必须可去重、可恢复。
- 插件不能绕过宿主策略直接发消息。
- 不向用户展示模型隐式 reasoning。
- 不把虚构日常描述成现实经历。
- 未知外部送达结果不自动重发。
- 用户边界和暂停设置优先于主动生活。

## 11. 完成标准

功能完成需要同时满足：

- 进度账本迁移后可重启读取，重复事件不重复奖励。
- 长任务可以先确认、后执行、再分段收尾，`/stop` 能取消。
- 主动生活候选受每日预算、安静时间和未回复规则约束。
- 虚拟日常能够在用户长时间离开后生成一次低压力问题，且不会超过每日预算。
- 插件观察可以进入候选队列，但不能直接投递。
- 微信/飞书分段投递顺序稳定，失败和未知状态可恢复。
- UI 可以查看进度、章节、奖励来源并显式重置。
- 全量测试和构建通过，真实模型和第三方账号验证另行标注。
