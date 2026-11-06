import { useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Select, Slider, Spin, Switch, Tabs, Tag } from "antd";
import type { CompanionCommand, CompanionPermissions, CompanionSnapshot, RelationshipPreferences, CompanionFollowup } from "../../../../shared/companion";
import "./companion-settings.css";

const stages = { new: "初识", familiar: "熟悉", close: "亲密", long_term: "长期陪伴" };
const recordKinds = { turn: "互动线索", repair: "修复约定", diary: "虚构角色小记", preferences: "偏好变更", permissions: "能力变更", followup: "具体跟进" };
const followupStatuses = { active: "等待合适时间", awaiting_reply: "已关心，等待回复", completed: "已完成", paused: "已暂停", cancelled: "已取消" };
const localTime = (at: number) => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
type Command = CompanionCommand extends infer T ? T extends CompanionCommand ? Omit<T, "expectedRevision"> : never : never;
type Tool = { id: string; name: string; risk?: string; effectKind?: string };
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);

export function CompanionSettingsPanel() {
  const [isNarrowScreen, setIsNarrowScreen] = useState(false);
  const [activeTab, setActiveTab] = useState("relationship");
  const [snapshot, setSnapshot] = useState<CompanionSnapshot>();
  const [draft, setDraft] = useState<RelationshipPreferences>();
  const [permissions, setPermissions] = useState<CompanionPermissions>();
  const [tools, setTools] = useState<Tool[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [repair, setRepair] = useState("");
  const [confirm, setConfirm] = useState<Command>();
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([]);
  const [followup, setFollowup] = useState<{ id?: string; topic: string; conversationId: string; time: string }>({ topic: "", conversationId: "", time: localTime(Date.now() + 3_600_000) });
  function accept(value: CompanionSnapshot) {
    setSnapshot(value);
    const r = value.relationship;
    setDraft({ userLabel: r.userLabel ?? "", closeness: r.closeness, sharedGoals: [...r.sharedGoals], milestones: [...r.milestones], boundaries: [...r.boundaries], tasteNotes: [...r.tasteNotes], paused: r.paused, recordHistory: r.recordHistory, style: r.style, affection: r.affection, innerLifeEnabled: r.innerLifeEnabled, proactiveLifeEnabled: r.proactiveLifeEnabled });
    setPermissions({ ...value.permissions });
  }
  useEffect(() => {
    let active = true;
    if (!window.companion) { setError("关系管理接口不可用，请更新并重启服务。"); return; }
    void window.companion.get().then(value => { if (active) accept(value); }).catch(reason => { if (active) setError(String(reason.message ?? reason)); });
    void window.settings?.getToolCatalog?.().then(value => { if (active && Array.isArray(value)) setTools(value); }).catch(() => {});
    const chatStore = (window as typeof window & { chatStore?: { list(): Promise<Array<{ id: string; title: string }>> } }).chatStore;
    void chatStore?.list().then(value => { if (active && Array.isArray(value)) setSessions(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 576px)") : undefined;
    const update = () => setIsNarrowScreen(media ? media.matches : window.innerWidth <= 576);
    update();
    window.addEventListener("resize", update);
    media?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      media?.removeEventListener?.("change", update);
    };
  }, []);
  async function reload() {
    setBusy(true); setError(""); setNotice("");
    try { accept(await window.companion.get()); } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function command(value: Command) {
    if (!snapshot) return false;
    setBusy(true); setError(""); setNotice("");
    try {
      accept(await window.companion.update({ ...value, expectedRevision: snapshot.revision } as CompanionCommand));
      setNotice("已保存，下次回应会使用当前设置。"); setConfirm(undefined);
      if (value.type === "repair") setRepair("");
      return true;
    } catch (reason) { setError(String(reason)); return false; }
    finally { setBusy(false); }
  }
  async function exportData() {
    setBusy(true); setError("");
    try {
      const value = await window.companion.export();
      const url = URL.createObjectURL(new Blob([value], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "xilian-relationship.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const field = <K extends keyof RelationshipPreferences>(key: K, value: RelationshipPreferences[K]) => setDraft(current => current ? { ...current, [key]: value } : current);
  function editFollowup(item: CompanionFollowup) { setFollowup({ id: item.id, topic: item.topic, conversationId: item.conversationId, time: localTime(Math.max(item.nextEligibleAt, Date.now() + 3_600_000)) }); }
  async function saveFollowup() {
    if (await command({ type: "followup_save", ...(followup.id ? { id: followup.id } : {}), topic: followup.topic.trim(), conversationId: followup.conversationId, nextEligibleAt: new Date(followup.time).getTime() })) {
      setFollowup({ topic: "", conversationId: followup.conversationId, time: localTime(Date.now() + 3_600_000) });
    }
  }
  return <section className="cy-settings-section cy-companion" aria-label="同一个昔涟">
    <div className="cy-settings-section__heading"><h2>同一个昔涟</h2><p>陪你聊天、一起工作、写代码或学习，都是昔涟。相处偏好跨模式共享，工具授权独立控制。</p></div>
    {error && <Alert type="error" showIcon title={error} action={<Button onClick={() => void reload()} disabled={busy}>重新加载</Button>} />}
    {notice && <Alert type="success" title={notice} closable onClose={() => setNotice("")} />}
    {!snapshot || !draft || !permissions ? (!error && <Spin />) : <>
      <div className="cy-companion__status"><Tag>{stages[snapshot.relationship.stage]}</Tag><Tag>模拟情绪 · {snapshot.affect.renderedFeeling}</Tag>{snapshot.relationship.paused && <Tag>关系模拟已暂停</Tag>}<Button size="small" disabled={busy} onClick={() => void reload()}>刷新状态</Button></div>
      <Tabs activeKey={activeTab} onChange={setActiveTab} renderTabBar={isNarrowScreen ? () => <label className="cy-companion__mobile-tabs">设置分组<Select aria-label="昔涟设置分组" value={activeTab} onChange={setActiveTab} options={[
        { value: "relationship", label: "相处与形象" }, { value: "followups", label: "具体跟进" },
        { value: "permissions", label: "能力与权限" }, { value: "history", label: "记录与修复" },
      ]} /></label> : undefined} items={[
        { key: "relationship", label: "相处与形象", children: <div className="cy-companion__form">
          <p>沿用昔涟现有的形象与语言习惯。情绪是表达线索，不代表真人感受，也不会改变办事能力。</p>
          <label>对你的称呼<Input aria-label="对你的称呼" maxLength={80} value={draft.userLabel} onChange={e => field("userLabel", e.target.value)} /></label>
          <label>表达偏好<Select aria-label="表达偏好" value={draft.style} onChange={value => field("style", value)} options={[{ value: "natural", label: "原有昔涟风格" }, { value: "lively", label: "更活泼" }, { value: "gentle", label: "更温柔" }, { value: "concise", label: "更简洁" }]} /></label>
          <label className="cy-companion__wide">相处程度 · {Math.round(draft.closeness * 100)} / 100<Slider aria-label="相处程度" min={0} max={100} value={Math.round(draft.closeness * 100)} onChange={value => field("closeness", value / 100)} /><span>由你选择，不因聊天次数或离开时间自动增减；不自动授予工具权限。</span></label>
          <label className="cy-companion__switch">自然的亲昵表达<Switch aria-label="自然的亲昵表达" checked={draft.affection} onChange={value => field("affection", value)} /></label>
          <label className="cy-companion__switch">暂停关系模拟及主动关怀<Switch aria-label="暂停关系模拟及主动关怀" checked={draft.paused} onChange={value => field("paused", value)} /></label>
          <label className="cy-companion__switch">记录本轮关系线索<Switch aria-label="记录本轮关系线索" checked={draft.recordHistory} onChange={value => field("recordHistory", value)} /></label>
          <label className="cy-companion__switch">虚构角色小记<Switch aria-label="虚构角色小记" checked={draft.innerLifeEnabled} onChange={value => field("innerLifeEnabled", value)} /></label>
          <label className="cy-companion__switch cy-companion__wide">共同目标与重要时刻主动关怀<Switch aria-label="共同目标与重要时刻主动关怀" checked={draft.proactiveLifeEnabled} onChange={value => field("proactiveLifeEnabled", value)} /></label>
          <label className="cy-companion__wide">昔涟的兴趣与品味<Input.TextArea aria-label="昔涟的兴趣与品味" autoSize={{ minRows: 2, maxRows: 6 }} value={draft.tasteNotes.join("\n")} onChange={e => field("tasteNotes", e.target.value.split("\n"))} placeholder="每行一项，最多 30 项，每项 120 字；例如：喜欢雨天、蓝色和把复杂问题讲清楚" /></label>
          <p className="cy-companion__wide">需同时开启偏好设置中的主动聊天。重要时刻可写“MM-DD 名称”（每年）或“YYYY-MM-DD 名称”（单次）；只在白天按评分、勿扰与渠道设置判断是否发送。精确时间提醒请使用定时任务。</p>
          <p className="cy-companion__wide">角色小记每天最多一条，并明确标记虚构；不会为它单独发送消息。关闭关系记录不影响原始聊天历史和已启用的长期记忆，长期记忆请在“记忆”中设置。</p>
          {([ ["sharedGoals", "共同目标"], ["milestones", "重要时刻"], ["boundaries", "相处边界"] ] as const).map(([key, label]) => <label className="cy-companion__wide" key={key}>{label}<Input.TextArea aria-label={label} autoSize={{ minRows: 2, maxRows: 6 }} value={draft[key].join("\n")} onChange={e => field(key, e.target.value.split("\n"))} placeholder="每行一项，最多 30 项，每项 200 字" /></label>)}
          <div className="cy-companion__actions cy-companion__wide"><Button type="primary" loading={busy} onClick={() => void command({ type: "preferences", patch: { ...draft, sharedGoals: lines(draft.sharedGoals.join("\n")), milestones: lines(draft.milestones.join("\n")), boundaries: lines(draft.boundaries.join("\n")), tasteNotes: lines(draft.tasteNotes.join("\n")) } })}>保存相处偏好</Button><Button danger disabled={busy} onClick={() => setConfirm({ type: "reset_relationship" })}>重置关系</Button></div>
        </div> },
        { key: "followups", label: "具体跟进", children: <div className="cy-companion__form">
          <p className="cy-companion__wide">把希望昔涟之后关心的一件事记在这里。到达最早时间后，还会遵守主动聊天开关、评分、勿扰和渠道设置；不是精确定时提醒。微信或飞书只跟进当前绑定会话的事项。</p>
          {(!draft.proactiveLifeEnabled || draft.paused) && <Alert className="cy-companion__wide" type="info" title="当前未开启具体事项关怀。请在“相处与形象”开启主动关怀，并在偏好设置启用主动聊天。" />}
          <label className="cy-companion__wide">事项名称<Input aria-label="跟进事项名称" value={followup.topic} maxLength={200} placeholder="例如：论文答辩" onChange={e => setFollowup({ ...followup, topic: e.target.value })} /></label>
          <label>绑定会话<Select aria-label="跟进绑定会话" showSearch optionFilterProp="label" value={followup.conversationId || undefined} onChange={conversationId => setFollowup({ ...followup, conversationId })} options={[...sessions.map(item => ({ value: item.id, label: item.title || item.id })), ...(followup.conversationId && !sessions.some(item => item.id === followup.conversationId) ? [{ value: followup.conversationId, label: followup.conversationId }] : [])]} /></label>
          <label>最早跟进时间<Input aria-label="最早跟进时间" type="datetime-local" value={followup.time} onChange={e => setFollowup({ ...followup, time: e.target.value })} /></label>
          <div className="cy-companion__actions cy-companion__wide"><Button type="primary" disabled={busy || !followup.topic.trim() || !followup.conversationId || !followup.time} onClick={() => void saveFollowup()}>{followup.id ? "保存并重新约时间" : "添加跟进事项"}</Button>{followup.id && <Button disabled={busy} onClick={() => setFollowup({ topic: "", conversationId: "", time: localTime(Date.now() + 3_600_000) })}>取消编辑</Button>}</div>
          <p className="cy-companion__wide">发出一次后等待你回复，不会因为没有回复而反复催促。可在这里完成、暂停、取消或重新约时间。明确回复“事项名称已完成”或“事项名称不要再问了”也会关闭该事项；含糊表达不会自动猜测。</p>
          <div className="cy-companion__wide">{!(snapshot.followups?.length) ? <p>暂无具体跟进事项。</p> : snapshot.followups.map(item => <article className="cy-companion__record" key={item.id}>
            <div><strong>{item.topic}</strong> <Tag>{followupStatuses[item.status]}</Tag><p>会话：{sessions.find(session => session.id === item.conversationId)?.title || item.conversationId}</p><small>最早：{new Date(item.nextEligibleAt).toLocaleString()}{item.lastAskedAt ? ` · 上次关心：${new Date(item.lastAskedAt).toLocaleString()}` : ""}</small>{item.resolutionReason && <p>{item.resolutionReason}</p>}</div>
            <div className="cy-companion__actions"><Button size="small" disabled={busy} onClick={() => editFollowup(item)}>编辑 / 再约时间</Button>{item.status !== "completed" && <Button size="small" disabled={busy} onClick={() => void command({ type: "followup_status", id: item.id, conversationId: item.conversationId, status: "completed" })}>完成</Button>}{item.status === "active" && <Button size="small" disabled={busy} onClick={() => void command({ type: "followup_status", id: item.id, conversationId: item.conversationId, status: "paused" })}>暂停</Button>}{item.status !== "cancelled" && <Button size="small" disabled={busy} onClick={() => void command({ type: "followup_status", id: item.id, conversationId: item.conversationId, status: "cancelled" })}>取消</Button>}</div>
          </article>)}</div>
        </div> },
        { key: "permissions", label: "能力与权限", children: <div className="cy-companion__form">
          <p className="cy-companion__wide">这些限制作用于 Windows、Web、渠道和子任务的工具调用。它们不会提高现有文件权限；目录授权仍在“工具配置”中设置。外部渠道选择“后台直接执行工具”时不会等待 Web 审批，但暂停和禁止调用仍会即时生效。暂停不能撤销已经执行的操作，也不能隔离同进程运行的可信插件。</p>
          <label>能力范围<Select aria-label="能力范围" value={permissions.preset} onChange={preset => setPermissions({ ...permissions, preset })} options={[{ value: "inherit", label: "沿用现有授权" }, { value: "companion", label: "仅无副作用的基础工具" }, { value: "basic", label: "基础查询（只读文件与网络）" }, { value: "shared_life", label: "日常协作（写文件按原权限，其余审批）" }, { value: "full", label: "完整能力（写入、外发及未知操作需确认）" }]} /></label>
          <label className="cy-companion__switch">暂停新工具调用<Switch aria-label="暂停新工具调用" checked={permissions.paused} onChange={paused => setPermissions({ ...permissions, paused })} /></label>
          <label className="cy-companion__wide">禁止调用<Select aria-label="禁止调用" mode="multiple" showSearch optionFilterProp="label" value={permissions.deniedTools} onChange={deniedTools => setPermissions({ ...permissions, deniedTools })} options={tools.map(tool => ({ value: tool.id, label: `${tool.name} · ${tool.id} · ${tool.risk ?? "未知"} / ${tool.effectKind ?? "未知"}` }))} /></label>
          <label className="cy-companion__wide">每次确认<Select aria-label="每次确认" mode="multiple" showSearch optionFilterProp="label" value={permissions.confirmTools} onChange={confirmTools => setPermissions({ ...permissions, confirmTools })} options={tools.map(tool => ({ value: tool.id, label: `${tool.name} · ${tool.id}` }))} /></label>
          <p className="cy-companion__wide">桌面和 Web 普通运行会遵守“每次确认”；外部渠道选择后台执行时不会把确认卡投到 Web 等待。已有的工具轨迹与执行账本继续记录实际调用结果。</p>
          <div className="cy-companion__wide"><Button type="primary" loading={busy} onClick={() => void command({ type: "permissions", patch: permissions })}>保存能力限制</Button></div>
        </div> },
        { key: "history", label: "记录与修复", children: <div className="cy-companion__form">
          <p className="cy-companion__wide">自动线索可能误判，可删除。这里管理关系派生记录；聊天原文、向量记忆、Wiki、摘要及你自行保存的导出文件仍分别在原有入口管理。</p>
          <label className="cy-companion__wide">新的修复约定<Input.TextArea aria-label="新的修复约定" value={repair} maxLength={500} onChange={e => setRepair(e.target.value)} placeholder="例如：先回应我的问题，不要替我推测情绪。" /></label>
          <div className="cy-companion__actions cy-companion__wide"><Button disabled={busy || !repair.trim()} onClick={() => void command({ type: "repair", note: repair })}>记录约定</Button><Button disabled={busy} onClick={() => void exportData()}>导出关系数据</Button><Button danger disabled={busy} onClick={() => setConfirm({ type: "clear_history" })}>清空关系记录</Button></div>
          <div className="cy-companion__wide">{snapshot.records.length === 0 ? <p>暂无关系记录。</p> : snapshot.records.map(record => <article className="cy-companion__record" key={record.id}><div><Tag>{recordKinds[record.kind]}</Tag><time>{new Date(record.at).toLocaleString()}</time><p>{record.text}</p>{record.conversationId && <small>来源会话：{record.conversationId}{record.sourceEventId ? ` · 事件：${record.sourceEventId}` : ""}</small>}</div><Button size="small" danger disabled={busy} onClick={() => setConfirm({ type: "delete_record", id: record.id })}>删除</Button></article>)}</div>
        </div> },
      ]} />
    </>}
    <Modal open={Boolean(confirm)} title={confirm?.type === "reset_relationship" ? "重置关系设置与记录" : "删除关系记录"} onCancel={() => setConfirm(undefined)} onOk={() => confirm && void command(confirm)} okText="确认" cancelText="取消" confirmLoading={busy} okButtonProps={{ danger: true }}><p>{confirm?.type === "reset_relationship" ? "称呼、目标、边界、修复记录和模拟情绪将恢复默认。工具授权不变。" : "删除所选关系记录及其派生线索。原始聊天与其他记忆仍保留。"}</p></Modal>
  </section>;
}
