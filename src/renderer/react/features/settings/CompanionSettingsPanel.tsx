import { useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Select, Slider, Spin, Switch, Tabs, Tag } from "antd";
import type { CompanionCommand, CompanionPermissions, CompanionSnapshot, RelationshipPreferences } from "../../../../shared/companion";
import "./companion-settings.css";

const stages = { new: "初识", familiar: "熟悉", close: "亲密", long_term: "长期陪伴" };
const recordKinds = { turn: "互动线索", repair: "修复约定", diary: "虚构角色小记", preferences: "偏好变更", permissions: "能力变更" };
type Command = CompanionCommand extends infer T ? T extends CompanionCommand ? Omit<T, "expectedRevision"> : never : never;
type Tool = { id: string; name: string; risk?: string; effectKind?: string };
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);

export function CompanionSettingsPanel() {
  const [snapshot, setSnapshot] = useState<CompanionSnapshot>();
  const [draft, setDraft] = useState<RelationshipPreferences>();
  const [permissions, setPermissions] = useState<CompanionPermissions>();
  const [tools, setTools] = useState<Tool[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [repair, setRepair] = useState("");
  const [confirm, setConfirm] = useState<Command>();
  function accept(value: CompanionSnapshot) {
    setSnapshot(value);
    const r = value.relationship;
    setDraft({ userLabel: r.userLabel ?? "", closeness: r.closeness, sharedGoals: [...r.sharedGoals], milestones: [...r.milestones], boundaries: [...r.boundaries], paused: r.paused, recordHistory: r.recordHistory, style: r.style, affection: r.affection, innerLifeEnabled: r.innerLifeEnabled, proactiveLifeEnabled: r.proactiveLifeEnabled });
    setPermissions({ ...value.permissions });
  }
  useEffect(() => {
    let active = true;
    if (!window.companion) { setError("关系管理接口不可用，请更新并重启服务。"); return; }
    void window.companion.get().then(value => { if (active) accept(value); }).catch(reason => { if (active) setError(String(reason.message ?? reason)); });
    void window.settings?.getToolCatalog?.().then(value => { if (active && Array.isArray(value)) setTools(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  async function reload() {
    setBusy(true); setError(""); setNotice("");
    try { accept(await window.companion.get()); } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function command(value: Command) {
    if (!snapshot) return;
    setBusy(true); setError(""); setNotice("");
    try {
      accept(await window.companion.update({ ...value, expectedRevision: snapshot.revision } as CompanionCommand));
      setNotice("已保存，下次回应会使用当前设置。"); setConfirm(undefined);
      if (value.type === "repair") setRepair("");
    } catch (reason) { setError(String(reason)); }
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
  return <section className="cy-settings-section cy-companion" aria-label="同一个昔涟">
    <div className="cy-settings-section__heading"><h2>同一个昔涟</h2><p>陪你聊天、一起工作、写代码或学习，都是昔涟。相处偏好跨模式共享，工具授权独立控制。</p></div>
    {error && <Alert type="error" showIcon title={error} action={<Button onClick={() => void reload()} disabled={busy}>重新加载</Button>} />}
    {notice && <Alert type="success" title={notice} closable onClose={() => setNotice("")} />}
    {!snapshot || !draft || !permissions ? (!error && <Spin />) : <>
      <div className="cy-companion__status"><Tag>{stages[snapshot.relationship.stage]}</Tag><Tag>模拟情绪 · {snapshot.affect.renderedFeeling}</Tag>{snapshot.relationship.paused && <Tag>关系模拟已暂停</Tag>}<Button size="small" disabled={busy} onClick={() => void reload()}>刷新状态</Button></div>
      <Tabs items={[
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
          <p className="cy-companion__wide">需同时开启偏好设置中的主动聊天。重要时刻可写“MM-DD 名称”（每年）或“YYYY-MM-DD 名称”（单次）；只在白天按评分、勿扰与渠道设置判断是否发送。精确时间提醒请使用定时任务。</p>
          <p className="cy-companion__wide">角色小记每天最多一条，并明确标记虚构；不会为它单独发送消息。关闭关系记录不影响原始聊天历史和已启用的长期记忆，长期记忆请在“记忆”中设置。</p>
          {([ ["sharedGoals", "共同目标"], ["milestones", "重要时刻"], ["boundaries", "相处边界"] ] as const).map(([key, label]) => <label className="cy-companion__wide" key={key}>{label}<Input.TextArea aria-label={label} autoSize={{ minRows: 2, maxRows: 6 }} value={draft[key].join("\n")} onChange={e => field(key, e.target.value.split("\n"))} placeholder="每行一项，最多 30 项，每项 200 字" /></label>)}
          <div className="cy-companion__actions cy-companion__wide"><Button type="primary" loading={busy} onClick={() => void command({ type: "preferences", patch: { ...draft, sharedGoals: lines(draft.sharedGoals.join("\n")), milestones: lines(draft.milestones.join("\n")), boundaries: lines(draft.boundaries.join("\n")) } })}>保存相处偏好</Button><Button danger disabled={busy} onClick={() => setConfirm({ type: "reset_relationship" })}>重置关系</Button></div>
        </div> },
        { key: "permissions", label: "能力与权限", children: <div className="cy-companion__form">
          <p className="cy-companion__wide">这些限制作用于 Windows、Web、渠道和子任务的工具调用。它们不会提高现有文件权限；目录授权仍在“工具配置”中设置。暂停不能撤销已经执行的操作，也不能隔离同进程运行的可信插件。</p>
          <label>能力范围<Select aria-label="能力范围" value={permissions.preset} onChange={preset => setPermissions({ ...permissions, preset })} options={[{ value: "inherit", label: "沿用现有授权" }, { value: "companion", label: "仅无副作用的基础工具" }, { value: "basic", label: "基础查询（只读文件与网络）" }, { value: "shared_life", label: "日常协作（写文件按原权限，其余审批）" }, { value: "full", label: "完整能力（写入、外发及未知操作需确认）" }]} /></label>
          <label className="cy-companion__switch">暂停新工具调用<Switch aria-label="暂停新工具调用" checked={permissions.paused} onChange={paused => setPermissions({ ...permissions, paused })} /></label>
          <label className="cy-companion__wide">禁止调用<Select aria-label="禁止调用" mode="multiple" showSearch optionFilterProp="label" value={permissions.deniedTools} onChange={deniedTools => setPermissions({ ...permissions, deniedTools })} options={tools.map(tool => ({ value: tool.id, label: `${tool.name} · ${tool.id} · ${tool.risk ?? "未知"} / ${tool.effectKind ?? "未知"}` }))} /></label>
          <label className="cy-companion__wide">每次确认<Select aria-label="每次确认" mode="multiple" showSearch optionFilterProp="label" value={permissions.confirmTools} onChange={confirmTools => setPermissions({ ...permissions, confirmTools })} options={tools.map(tool => ({ value: tool.id, label: `${tool.name} · ${tool.id}` }))} /></label>
          <p className="cy-companion__wide">后台或无审批界面的运行遇到“每次确认”会停止该工具，不会悄悄放行。已有的工具轨迹与执行账本继续记录实际调用结果。</p>
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
