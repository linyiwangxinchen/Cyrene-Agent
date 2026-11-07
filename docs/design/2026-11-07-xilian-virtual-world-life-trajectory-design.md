# 昔涟虚拟世界与每日生活轨迹实现方案

状态：实施中。本文件冻结设计与施工顺序；当前已完成世界契约、独立存储、确定性日程、生活快照，以及 Windows/Linux Web 的只读上下文接入。

目标：让昔涟拥有一个可以持续推进、可回放、可追问的虚拟人生。自拍只是生活事件产生的一个结果；每一张自拍都必须能够回答“什么时候、在哪里、正在做什么、为什么想拍、接下来准备做什么”。

当前实现边界：世界状态已经会在主进程主动评估、桌面普通聊天和 Linux/Web 请求时推进，并以事件 ID 幂等保存；陪伴设置页已能只读查看当前地点、活动、目标和当天轨迹；桌面 Chat 与 Linux/Web 的明确自拍请求都已经绑定生活事件 artifact，并在图片落盘后记录成功或失败。主动消息仍沿用原有冷却、预算、未回复保护和渠道 outbox；当前不会因为有生活事件就自动生成图片或越过主动消息开关。

翁法罗斯提供的是结构灵感，而不是要直接复制的角色、地名或剧情。可以借鉴“与外界隔绝的世界、多城邦生活、神话权能、周期性灾厄、记忆与重启”的叙事骨架。官方介绍强调了翁法罗斯的封闭性、十二泰坦、黑潮和奥赫玛避难所；公开设定也把它描述为带有演算世界和循环记忆结构的世界。[官方版本介绍](https://blog.zh-hant.playstation.com/2025/01/14/20250114-honkaistarrail/)[翁法罗斯设定资料](https://wiki.biligame.com/sr/%E7%BF%81%E6%B3%95%E7%BD%97%E6%96%AF)

## 1. 设计结论

当前的 `CompanionLifeState` 继续负责短期状态，`CompanionMoment` 继续负责等待投递的内容，`BondProgressState` 继续负责只增不减的羁绊进度。新增一层 `XilianWorldState`，负责世界、日程、目标、地点和生活事件。

四个领域必须保持独立：

| 领域 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| `RelationshipState` | 用户设置的称呼、边界、共同目标、关系偏好 | 自动增加亲密度、虚构世界事实 |
| `CompanionLifeState` | 精力、好奇、无聊、每日预算 | 世界历史和长期剧情 |
| `XilianWorldState` | 世界时间、地点、活动、目标、生活事件 | 工具权限和真实用户事实 |
| `BondProgressState` | 游戏化羁绊章节和奖励 | 现实权限、模型能力、世界强制进度 |

模型只负责在可信状态上生成表达。模型不能凭空决定地点、过去发生的事件或长期目标；这些事实由本地状态机产生并传入上下文。

## 2. 当前代码基线

已有实现可以直接复用：

- `src/main/proactive/companion-life.ts`：短期虚拟状态、每日预算、生活心事队列和跨日状态。
- `src/main/proactive/proactive-lifecycle.ts`：主动候选、渠道可用性、安静时间、未回复保护和投递提交。
- `src/main/relationship/relationship-log-core.ts`：关系记录、跟进事项、羁绊事件和进度账本。
- `src/main/persona/xilian-pack.ts`：昔涟身份、表达规则和虚构生活素材。
- `src/main/persona/xilian-image-prompt.ts`：Windows、Linux/Web 共用的视觉锚点。
- `src/main/orchestrator/vendors/model-factory.ts`：Responses 图片生成工具和旧图片模型别名迁移。
- `src/server/web-model-service.ts`：Linux/Web 模型档案展开与请求入口。

第二阶段不再把更多状态继续塞进 `CompanionMoment.summary`。心事只保存摘要和引用，生活事实保存到时间线事件。

## 3. 虚拟世界设定

### 3.1 工作名称与世界边界

工作名称暂定为“涟界”。它是运行在本地或 Linux 服务端数据目录中的虚构世界，和现实网络、用户真实地点、用户真实行程完全隔离。昔涟可以说“我在涟界的星炉台”，不能把它说成自己真的在现实地点生活。

世界不直接使用翁法罗斯的地名、人物和原剧情。借鉴的只是以下结构：

- 一个外界很难观测的封闭世界。
- 多个生活方式不同的城邦。
- 一套影响记忆、时间或世界运行的规则。
- 一个逐渐显现的长期威胁。
- 通过日常劳动、探索和关系维持世界的连续性。

### 3.2 第一版地点

第一版只建立少量地点，确保每个地点都有实际用途：

| 地点 | 日常用途 | 可产生的事件 |
| --- | --- | --- |
| 序页城 | 整理记忆、抄录档案、查找旧记录 | 找到旧页、修复档案、记录新线索 |
| 星炉台 | 维护光源、测试装置、处理世界能源 | 完成修理、发现异常光谱、拍摄工作自拍 |
| 静海庭 | 休息、喝茶、听歌、整理情绪 | 疲惫小记、雨天歌单、安静自拍 |
| 回声场 | 记忆棋盘、模拟游戏、练习策略 | 赢下一局、输掉挑战、想问用户玩法 |
| 远观台 | 观察天空、记录城邦变化、思考长期目标 | 远景自拍、发现异常、提出世界问题 |
| 渡桥集 | 采购小物、与虚构居民交换消息 | 带回礼物、听到传闻、分享有趣见闻 |

### 3.3 第一版长期主线

长期主线使用原创概念“星烛与回声”，分为三个阶段：

1. **点灯期**：昔涟维护日常光源，学习记录世界，并建立自己的生活习惯。
2. **回声期**：旧事件在不同地点留下重复痕迹，她开始意识到世界存在被重写的记忆。
3. **远行期**：她决定离开熟悉区域，寻找导致回声的源头；用户可以陪她讨论路线，但不能替她自动完成全部人生。

每个阶段包含 3–5 个目标、若干生活事件和少量里程碑。阶段推进不依赖用户每天回复，用户的帮助只改变事件方向和羁绊奖励。

## 4. 数据模型

新增 `src/shared/xilian-world.ts`：

```ts
type XilianWorldActivityKind =
  | "work"
  | "study"
  | "game"
  | "rest"
  | "explore"
  | "social"
  | "maintenance"
  | "travel";

interface XilianLocation {
  id: string;
  name: string;
  description: string;
  activityKinds: XilianWorldActivityKind[];
  tags: string[];
}

interface XilianLifeGoal {
  id: string;
  title: string;
  description: string;
  stage: "active" | "paused" | "completed";
  progress: number;
  target: number;
  importance: number;
  startedAt: number;
  updatedAt: number;
}

interface XilianTimelineEvent {
  id: string;
  occurredAt: number;
  dateKey: string;
  locationId: string;
  activityKind: XilianWorldActivityKind;
  activityTitle: string;
  summary: string;
  mood: string;
  energyAfter: number;
  goalId?: string;
  status: "planned" | "active" | "completed" | "interrupted";
  visibility: "private" | "shareable" | "shared";
  source: "simulated_world" | "plugin_observation" | "user_interaction";
  previousEventId?: string;
  nextEventId?: string;
}

interface XilianWorldState {
  version: 1;
  worldDate: string;
  seasonId: string;
  dayIndex: number;
  currentLocationId: string;
  currentActivity?: XilianTimelineEvent;
  activeArcId: string;
  goals: XilianLifeGoal[];
  recentEventIds: string[];
  nextPlannedEvent?: XilianTimelineEvent;
  revision: number;
}
```

`CompanionLifeData` 升级到 version 3，加入 `world`、`timeline` 和 `artifacts`：

```ts
interface XilianLifeArtifactContext {
  id: string;
  eventId: string;
  kind: "selfie" | "note" | "song" | "question";
  createdAt: number;
  promptFingerprint: string;
  imageModel?: string;
  outputPath?: string;
  status: "planned" | "generated" | "failed";
}
```

迁移规则：

- version 1/2 的 `CompanionMoment` 和短期状态全部保留。
- 旧每日小记转换为 `simulated_world` 的 `shareable` 事件。
- 没有世界状态时创建“点灯期”、序页城、一个长期目标和一个当天计划。
- 迁移失败只使用安全默认世界，不能删除旧的生活队列。

## 5. 时间推进与日程生成

### 5.1 时间块

使用用户时区，把一天切成七个时间块：

```text
清晨 06:00–08:00
上午 08:00–11:30
午间 11:30–13:30
下午 13:30–17:30
傍晚 17:30–19:30
夜间 19:30–23:00
安静时间 23:00–06:00
```

程序不每分钟调用模型。触发方式只有三种：

- 用户打开聊天或发送消息时补齐过去的时间线。
- 主动策略每分钟扫描时，只做纯函数状态推进。
- 发生插件观察、自拍、目标完成等事件时立即追加一条事件。

### 5.2 确定性日程

日程由以下输入决定：

- `dateKey`、世界 `dayIndex` 和世界版本。
- 当前阶段目标及其重要性。
- 精力、好奇、无聊。
- 前一天已完成的活动。
- 当天用户互动和插件观察。

使用稳定 hash 作为随机种子。相同日期、相同世界版本和相同事件历史重启后得到同一日程；世界发生新事件后才重新规划后续时间块。

基础模板不直接决定每句话，只决定活动事实：

| 状态 | 适合活动 |
| --- | --- |
| 精力高、好奇高 | 探索、工作、研究、远行准备 |
| 精力中等 | 档案整理、游戏、城邦社交 |
| 精力低 | 静海庭休息、听歌、整理便签 |
| 无聊高 | 回声场游戏、渡桥集闲逛、向用户问一个轻问题 |
| 长时间未互动 | 只生成一次低压力分享或提问，不连续追问 |

必须保证：

- 同一时间只有一个 `active` 活动。
- 活动结束后才能生成下一活动。
- 精力过低时不能连续安排工作或远行。
- 已完成的活动不能因重启重新执行。
- 模型不能直接修改活动状态，只能提出候选结果，由状态机验收。

## 6. 生活事件与自拍上下文

所有可分享内容都从 `XilianTimelineEvent` 派生。生成自拍前先创建一个 `XilianLifeArtifactContext`，再生成 `XilianLifeSnapshot`：

```ts
interface XilianLifeSnapshot {
  worldDate: string;
  localTime: string;
  season: string;
  location: string;
  currentActivity: string;
  recentEvent: string;
  nextPlan: string;
  mood: string;
  energy: number;
  outfit: string;
  selfieReason: string;
  visualAnchors: string[];
  avoid: string[];
  sourceEventId: string;
}
```

示例：

```text
时间：傍晚
地点：星炉台西侧观测台
活动：完成今日光谱记录
状态：有一点疲惫，但因为记录成功而开心
自拍原因：夕阳照到头发，她想把这一刻留下来
下一计划：回静海庭整理记录，再玩一局记忆棋盘
```

图片请求必须包含：

- 原创世界中的地点和活动。
- 当前时间段和拍摄原因。
- 昔涟稳定视觉锚点。
- 竖构图、脸部清晰和单人物约束。
- `sourceEventId` 对应的事件摘要，不发送完整内部数据库。

生成成功后把 artifact 绑定到事件；生成失败时事件保持 `shareable`，只记录失败原因并允许后续重试，不能重复创建一条新的生活经历。

## 7. 主动消息决策

主动消息分三步：

1. **生活状态筛选**：是否到了合适的时间块，精力/无聊/好奇是否支持这类活动。
2. **现有 ProactivePolicy**：安静时间、全局冷却、未回复数量、渠道可用性和每日预算。
3. **模型表达决策**：分享、轻问、玩笑或 `silent`。

候选必须带上：

```ts
interface LifeCandidateContext {
  eventId: string;
  momentKind: "share" | "ask" | "checkin" | "joke";
  whyNow: string;
  userRelevance: string;
  source: "simulated_world" | "plugin_observation";
  snapshot: XilianLifeSnapshot;
}
```

不同类型的消息：

- `share`：分享刚完成的事、地点或发现。
- `ask`：只问一个轻问题，例如“你会选哪种颜色？”
- `checkin`：用户最近主动提过目标时，询问近况。
- `joke`：由游戏失败、意外小事或虚构 NPC 对话触发。
- `selfie`：只有事件有明确视觉理由时才生成，不能把自拍当作普通问候的默认附件。

插件观察仍然和虚构生活分开。插件可以成为“她看到了一段内容”的外部证据，但不能直接写入她的虚构经历；如果她把插件内容带进涟界，必须产生一个明确的“转述/灵感”事件。

## 8. 目标、城邦和人物关系

第一版不做无限 NPC。先固定 4–6 个可回放角色，每个角色只有：

- 稳定身份和说话方式。
- 与昔涟的关系状态。
- 当前地点和工作。
- 最近一次互动事件。
- 一个可推进的小目标。

昔涟自己的长期目标建议从以下三类开始：

- **维护型**：修复星炉、整理档案、维持世界运行。
- **探索型**：寻找回声来源、访问未登记地点、收集星烛。
- **成长型**：学习一项新技能、完成一局游戏、学会表达疲惫和求助。

用户可以参与目标，但不必每天陪她完成；她有自己的推进速度、暂停和重新规划。

## 9. Windows、Linux/Web 和插件共用路径

不能再由 Windows 直接拼 prompt、Linux 走另一套文本。统一入口：

```text
XilianWorldStore
      ↓
XilianScheduleEngine
      ↓
XilianLifeSnapshotBuilder
      ↓
ProactiveMoment / ImageGenerationRequest
      ↓
Windows main / Linux headless / Web model service
```

三端只允许替换：

- 数据目录。
- 模型档案和认证配置。
- 发送渠道。

地点、活动、事件、自拍原因和视觉锚点必须来自同一份共享状态。这样用户在 Windows 上问到的“今天下午在干什么”，切到 Linux/Web 后仍能得到同一答案。

## 10. 隐私、事实和失败边界

- 涟界内的地点、居民和活动必须用“虚构世界”身份表达。
- 不把服务器上的世界状态说成用户现实生活或昔涟的真实身体经历。
- 插件观察只携带脱敏摘要，不带 token、cookie、评论者个人信息和内部调试输出。
- 图片请求只传当前必要的 `LifeSnapshot`，不传整个生活数据库。
- 生成失败不能被伪装成“已经拍好了”；应该说“刚才的拍摄没有完成，可以稍后再试”。
- 未知送达不消费心事、不增加羁绊奖励、不重复生成事件。
- 用户关闭虚拟日常后，已排队的虚构事件立即停止投递；历史时间线仍可查看。

## 11. 实施阶段

### Phase 0：冻结设定和契约

- 新增本文件和 `xilian-world.ts` 的类型契约。
- 确定地点、活动、第一阶段目标和 NPC 白名单。
- 不修改现有主动消息行为。

### Phase 1：世界状态和事件存储

- 扩展 `CompanionLifeData` 到 version 3。
- 新增 `XilianWorldStore`，实现迁移、原子写入、事件去重和时间线查询。
- 新增确定性日期种子和世界日推进。
- 覆盖重启、跨日、重复事件、损坏文件和旧 version 迁移。

### Phase 2：日程和活动状态机

- 新增 `XilianScheduleEngine`。
- 实现七个时间块、活动模板、精力约束和目标推进。
- 把当前每日虚构小记改为从真实时间线事件生成。
- 加入“长时间没有互动时只生成一次低压力事件”的规则。

### Phase 3：统一上下文和自拍

- 新增 `XilianLifeSnapshotBuilder`。
- Windows、Linux/Web 共用 snapshot 到 prompt 的转换。
- 自拍 artifact 与事件绑定，加入成功、失败、重试测试。
- 对 `gpt-image-2` 等旧配置做统一模型迁移。

### Phase 4：主动消息和插件

- 将 life event 映射为 `CompanionMoment`。
- 插件观察通过“外部观察 → 可选转述”进入世界，不直接改变虚构世界事实。
- 统一现有每日预算、全局冷却、未回复保护和渠道 outbox。

### Phase 5：UI 和可追问体验

- 陪伴页增加“当前状态”“今天的轨迹”“长期目标”“最近地点”。
- 支持查看某条自拍对应的时间、地点、活动和拍摄原因。
- 提供暂停虚拟世界、仅停止主动消息、清理时间线三种不同操作。
- Web 与 Windows 共享同一组查询接口。

### Phase 6：验收和部署

- 运行四套 TypeScript 检查、全量 Vitest、Web/headless 构建。
- 用固定时钟回放 7 天生活轨迹，检查事件顺序和目标推进。
- 使用第三方 Responses 配置进行一次真实图片请求，确认 400、401、503、超时和图片结果解析路径。
- Linux 部署后重新检查模型档案、`imageGeneration`、图片工具和当前世界状态迁移。

## 12. 验收标准

完成后必须满足：

1. 昔涟每天有可查询的地点、活动、情绪和下一计划。
2. 同一天重启不会生成两套互相矛盾的生活。
3. 自拍可以反向追溯到唯一生活事件和拍摄原因。
4. 用户问“你刚才在干什么”时，回答来自事件时间线，而不是临时编造。
5. 用户问“你今天做了什么”时，可以得到当天摘要和未分享的安全概览。
6. 精力低时会休息，无聊高时会选择游戏、探索或轻问候。
7. 生活目标可以持续数日推进，完成后产生里程碑，不因用户暂时离开而自动失败。
8. Windows、Linux/Web、插件使用同一套世界状态和 snapshot 契约。
9. 生图失败、渠道未知送达、进程重启和配置迁移都不会重复创建虚假经历。
10. 所有虚拟世界内容都明确属于昔涟的虚构生活，不越过现实事实和权限边界。

## 13. 第一批实际文件

建议第一批只改这些文件，避免一次性扩散：

- `src/shared/xilian-world.ts`
- `src/main/proactive/xilian-world-store.ts`
- `src/main/proactive/xilian-schedule.ts`
- `src/main/proactive/xilian-life-context.ts`
- `src/main/proactive/companion-life.ts`
- `src/main/proactive/proactive-lifecycle.ts`
- `src/main/persona/xilian-pack.ts`
- `src/main/persona/xilian-image-prompt.ts`
- `src/server/web-model-service.ts`
- `src/server/web-persona-runtime.ts`
- 对应的迁移、回放和图片请求测试文件

第一阶段不做自动生成大量 NPC、不做实时世界物理模拟、不让模型拥有直接写状态的权限。先把“每天发生什么 → 形成事件 → 生成可靠上下文 → 决定是否分享”这条链打通，再扩展世界规模。

## 14. 与现有消息链的衔接

这项功能不需要另起一套发送协议。现有链路已经具备两个重要能力：`CompanionLifeStore` 可以保存待投递的 `CompanionMoment`，`outgoing-composer.ts` 和 `message-segmentation.ts` 可以按自然语气把一条回复拆成多个消息段。新的世界层只负责产生“值得分享的生活事实”和消息候选，发送仍然经过现有的主动策略、outbox 和渠道能力检查。

推荐的调用顺序如下：

```text
clock / user message / plugin observation
              ↓
XilianWorldStore.advance()
              ↓
XilianScheduleEngine.reconcile()
              ↓
XilianLifeSnapshotBuilder.fromEvent()
              ↓
CompanionLifeStore.enqueueMoment()
              ↓
ProactivePolicy + model decision
              ↓
OutgoingComposer（自然分条）
              ↓
channel outbox / desktop chat / Web history
```

因此，“更像人”要由三个层次共同完成：状态机保证她确实有正在做的事，主动策略判断现在是否适合打扰，表达层再决定是发一条、分成几条、附带图片还是保持安静。模型不能跳过前两层直接编造一段生活。

现有的 `GLOBAL_PROACTIVE_INTERVAL_MS`、安静时间、未回复上限和每日预算继续作为硬闸门。预算可以更活跃，但不能绕过用户关闭主动消息、夜间保护、渠道不可用或消息未确认送达这些边界。主动消息的正文仍然限制为短、少问、多分享；长内容交给正常聊天。

## 15. 存储与并发契约

第一版建议把世界时间线放在独立文件 `xilian-world.json`，不要立即把整个 `companion-life.json` 改成一个大型 version 3 文档。这样可以把迁移风险限制在新 store 内，并且保留旧版心事队列的回滚能力。稳定的数据目录布局为：

```text
<dataDir>/companion-life.json       # 短期情绪、预算、待投递心事
<dataDir>/xilian-world.json         # 世界状态、目标、时间线、artifact 索引
<dataDir>/xilian-world-events/      # 可选的按月归档，不作为第一版依赖
```

`XilianWorldStore` 必须提供以下原子操作：

- `readSnapshot()`：返回经过 schema 校验的只读快照。
- `advance(now, timezone)`：补齐已经过去的时间块，并且对同一个时间块幂等。
- `appendEvent(event)`：使用 `event.id` 去重，不能因为重启重复写入。
- `claimArtifact(eventId, kind)`：一个事件对同一种 artifact 只能有一个进行中的生成任务。
- `completeArtifact(id, result)` / `failArtifact(id, reason)`：只改变 artifact 状态，不重写原生活事件。
- `queryTimeline(range)`：按用户时区返回已完成事件，默认限制条数和字段长度。

写入采用临时文件加 rename；若发现 JSON 损坏，先保留原文件副本，再从最近安全快照或默认世界恢复。所有变更都带 `revision`，生成前记录 revision，提交时发现 revision 变化则重新构建 snapshot，避免旧请求覆盖新生活。

时间推进不依赖后台每分钟唤醒模型。触发器只负责唤醒纯 TypeScript 状态机；模型调用只发生在表达、追问或生图阶段。服务器重启后，第一次读取世界时按当前时区一次性补齐缺失块，并把过期的“计划中”活动标记为 `interrupted` 或 `completed`，不能把离线时间伪装成每一分钟都在工作。

## 16. 自拍与图片请求的具体契约

自拍不是独立的“随机图片按钮”，而是生活事件的派生 artifact。`XilianLifeSnapshotBuilder` 必须先验证：事件已经存在、地点和活动属于白名单、事件状态可以分享、此前没有相同 artifact 在生成。通过后才创建 `planned` artifact。

传给图片模型的内容分为三块：

1. 稳定的昔涟视觉锚点：发色、发型、服饰基调、年龄感、单人物和画面质量约束。
2. 当前生活上下文：世界日期、时间段、地点、活动、心情、自拍原因、服装变化和画面动作。
3. 明确的排除项：不要把虚构地点画成现实城市，不要出现第二个人物、文字水印、相机 UI、未授权品牌和与当前活动冲突的道具。

图片请求只带 `sourceEventId` 的摘要指纹，不把整条时间线或用户聊天记录发送给第三方服务。成功返回后 artifact 记录模型名、尺寸、文件路径和 prompt fingerprint；失败只记录可重试的错误分类（认证、参数、网络、超时、解析），不新增第二条生活经历。图片附加到消息时，消息文本仍然要能在没有图片的渠道上独立成立。

## 17. 追问与“刚才在做什么”的事实查询

正常聊天上下文增加一个轻量只读 `lifeContext`，最多包含当前活动、最近三条已完成事件、下一计划和一条长期目标。用户问“刚才”“今天”“在哪里”时，先按用户时区查询时间线，再把结果交给模型表达；没有匹配事件时明确说“这段时间没有记录”，不能用模型常识补写。

主动消息只引用 `shareable` 事件。`private` 事件可以用于内部连续性，但不能因为模型觉得有趣就自动发送。用户明确要求查看轨迹时，才把地点、活动和事件摘要完整列出；默认主动消息只分享一小段，降低打扰和隐私暴露。

## 18. 分阶段提交与回滚点

建议按下面的提交边界实现，每一步都能独立测试和回滚：

1. `world-contract`：共享类型、地点/活动白名单、默认世界和 schema 校验；不接入发送链。
2. `world-store`：独立文件、迁移、原子写入、幂等事件和固定时钟测试。
3. `world-schedule`：时间块、确定性种子、精力约束、目标推进和七日回放测试。
4. `life-snapshot`：从事件生成查询上下文、自拍上下文和 artifact 状态机；加入图片请求契约测试。
5. `proactive-life-bridge`：把合格事件映射为 `CompanionMoment`，复用现有预算、冷却、outbox 和自然分条。
6. `web-desktop-parity`：Windows 与 Linux/Web 注入同一个只读 snapshot，补齐 Web 端查询接口和 UI。
7. `world-controls`：暂停世界、暂停主动消息、清理历史三种控制和审计日志。

每个提交都需要保留上一阶段的测试绿色。任何阶段出现 schema 迁移失败、第三方生图失败或渠道未知送达，都应该回滚该阶段的桥接，不回滚已经写入的可追溯世界事件。

## 19. 可观测性与验收证据

调试日志只记录事件 ID、日期、地点 ID、活动 ID、候选类型、策略阻断原因和 artifact 状态，不记录 token、完整 prompt、用户隐私或图片 base64。为方便验收，增加一个只读诊断结果：

```text
worldDate / timezone / currentLocation / currentActivity
lastEventId / nextEventId / activeArc / goalProgress
pendingMoments / dailyBudget / proactiveBlockReason
lastArtifactStatus / imageModel / imageErrorClass
```

交付前至少保存以下证据：

- 固定时钟连续回放 7 天的 JSON 时间线和摘要哈希。
- 进程重启前后同一天的事件 ID 对比，没有重复活动。
- 从一条自拍 artifact 反查到唯一事件、地点、活动和自拍原因。
- Windows 与 Linux/Web 对同一 `world revision` 的查询结果一致。
- 第三方 Responses 图片请求的成功、400 参数错误、401 认证错误、超时和解析失败测试结果。
- 主动消息关闭、夜间、未回复上限、渠道不可用时均没有越权发送。

达到这些证据后，才进入扩展 NPC、更多地点和更长主线；在此之前不把世界规模扩大到难以回放的“无限生成”。
