import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Modal, Space, Tag } from "antd";
import type { ChannelRecoveryApi, ChannelRecoveryItem } from "../../../../shared/channel-recovery";
export type { ChannelRecoveryApi, ChannelRecoveryItem } from "../../../../shared/channel-recovery";
const labels: Record<string, string> = { queued: "等待处理", running: "处理中", completed: "已完成", failed: "失败", unknown: "待确认", cancelled: "已取消", cancelling: "取消中，等待当前处理结束", pending: "待发送", sending: "发送中", sent: "已送达", corrupt: "记录损坏" };

export function ChannelRecoveryPanel({ api }: { api: ChannelRecoveryApi }) {
  const [items, setItems] = useState<ChannelRecoveryItem[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const refresh = useCallback(async () => {
    try { setItems(await api.list()); setError(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try { const result = await task() as { ok?: boolean; error?: string }; if (result?.ok === false) throw new Error(result.error || "恢复未完成"); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const visible = items.filter(item => showCompleted || !["completed", "cancelled"].includes(item.status));
  return <section className="cy-settings-card" aria-label="渠道消息恢复">
    <h3>消息恢复与送达确认</h3>
    <p>显示待处理记录与最近 200 条已结束记录。重启前正在执行的任务或发送结果未知的片段，需要核对后恢复；已确认送达的片段不会重复发送。</p>
    {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
    <Space wrap style={{ marginBottom: 12 }}>
      <Button loading={busy} onClick={() => void refresh()}>刷新记录</Button>
      <Button onClick={() => setShowCompleted(value => !value)}>{showCompleted ? "仅看待处理" : "显示已完成"}</Button>
    </Space>
    {!visible.length && <p>暂无待处理记录。</p>}
    {visible.map(item => <article key={item.id} style={{ borderTop: "1px solid var(--border-color, #ddd)", padding: "12px 0", overflowWrap: "anywhere" }}>
      <Space wrap><strong>{item.kind === "corrupt" ? "恢复记录" : `${item.channel} · ${item.kind === "inbox" ? "收到消息" : "发送回复"}`}</strong><Tag color={item.status === "unknown" ? "orange" : item.status === "corrupt" ? "red" : undefined}>{labels[item.status] ?? item.status}</Tag><span>{new Date(item.updatedAt).toLocaleString()}</span></Space>
      <p style={{ whiteSpace: "pre-wrap" }}>{item.preview || "（附件消息）"}</p>
      <small>目标：{item.targetId}{item.conversationId ? ` · 会话：${item.conversationId}` : ""}</small>
      {item.error && <p role="status">{item.error}</p>}
      {item.parts.map(part => <div key={part.index} style={{ marginTop: 8 }}>
        <Space wrap><span>片段 {part.index + 1} · {part.kind}</span><Tag>{labels[part.status] ?? part.status}</Tag>
          {part.status === "unknown" && !item.active && <>
            <Button size="small" disabled={busy} onClick={() => Modal.confirm({ title: "确认这个片段已送达？", content: "请先在微信/飞书/QQ 对话中核对。确认后会跳过这个片段。", okText: "已核对，已送达", onOk: () => run(() => api.resolve({ id: item.id, index: part.index, outcome: "sent", confirmed: true })) })}>确认已送达</Button>
            <Button size="small" disabled={busy} onClick={() => Modal.confirm({ title: "确认这个片段没有送达？", content: "只有核对远端对话确实未收到后，才允许后续重新发送。", okText: "已核对，未送达", onOk: () => run(() => api.resolve({ id: item.id, index: part.index, outcome: "not_sent", confirmed: true })) })}>确认未送达</Button>
          </>}
        </Space>{part.error && <small style={{ display: "block" }}>{part.error}</small>}
      </div>)}
      {item.kind !== "corrupt" && !item.active && !["completed", "cancelled"].includes(item.status) && <Space wrap style={{ marginTop: 12 }}>
        <Button disabled={busy || item.parts.some(part => part.status === "unknown" || part.status === "sending")} onClick={() => Modal.confirm({ title: item.kind === "inbox" ? "确认恢复这条消息的处理？" : "恢复未送达片段？", content: item.kind === "inbox" ? "请先核对这条任务先前的工具执行结果，避免重复修改文件、操作账户等副作用。会保持原会话绑定；已有 CTA 回复不会重新生成。" : "只发送未完成片段，跳过已确认送达的内容。", okText: "已核对，恢复", onOk: () => run(() => api.retry({ id: item.id, confirmed: true })) })}>恢复</Button>
        <Button disabled={busy} onClick={() => Modal.confirm({ title: "取消后续处理？", content: "不会撤回已送达的消息。未知结果仍保留供你核对。", onOk: () => run(() => api.cancel({ id: item.id })) })}>取消</Button>
      </Space>}
    </article>)}
  </section>;
}
