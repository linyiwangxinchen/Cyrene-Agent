import { useState } from "react";
import { Alert, Button, Checkbox, Input, Modal } from "antd";
import type { MemoryEditCommand, MemoryExplanation } from "../../../../shared/memory-governance";

export function MemoryRecordActions({ id, onChanged }: { id: string; onChanged(): Promise<void> }) {
  const [detail, setDetail] = useState<MemoryExplanation>();
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [confirm, setConfirm] = useState<"archive" | "delete">();
  const [profileKeys, setProfileKeys] = useState<string[]>([]);
  const [wikiKeys, setWikiKeys] = useState<string[]>([]);
  const [preventReplay, setPreventReplay] = useState(true);
  async function open() {
    setBusy(true); setError(""); setWarning("");
    try { const result = await window.memoryGovernance.explain(id); setDetail(result); setContent(result.content); setProfileKeys([]); setWikiKeys([]); setPreventReplay(Boolean(result.related?.sources.length)); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function change(action: MemoryEditCommand["action"]) {
    if (!detail) return;
    setBusy(true); setError("");
    try {
      const selection = action === "delete" && detail.related ? {
        revision: detail.related.revision, memoryIds: detail.related.memories.map(item => item.id), profileKeys,
        wikiClaims: detail.related.wikiClaims.filter(item => wikiKeys.includes(JSON.stringify([item.pageId, item.claimId]))).map(({ pageId, claimId }) => ({ pageId, claimId })), preventReplay,
      } : undefined;
      const result = await window.memoryGovernance.change({ id, expectedContent: detail.content, action, ...(action === "edit" ? { content } : {}), ...(selection ? { selection } : {}) } as MemoryEditCommand);
      if (result.warning) setWarning(result.warning);
      // Deleting refreshes the list and unmounts this row; keep partial-failure
      // feedback outside its lifecycle so the cleanup warning is not lost.
      if (result.warning && action === "delete") Modal.warning({ title: "部分清理尚未完成", content: result.warning, okText: "知道了" });
      await onChanged(); setConfirm(undefined);
      if (!result.warning || action === "delete") setDetail(undefined);
      else if (action === "edit") setDetail({ ...detail, content });
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <><Button size="small" loading={busy} onClick={() => void open()}>来源与管理</Button>{error && !detail && <Alert type="error" title={error} />}{warning && !detail && <Alert type="warning" title={warning} />}
    <Modal title="记忆来源与管理" open={Boolean(detail)} onCancel={() => !busy && setDetail(undefined)} footer={null}>
      {error && <Alert type="error" title={error} />}{warning && <Alert type="warning" title={warning} />}
      <p>来源会话：{detail?.conversationId || "历史记录未保留来源"}</p>
      <p>提取置信度：{detail?.confidence == null ? "原记录未保存，不补造评分" : detail.confidence}</p>
      {detail?.sourceQuote && <blockquote>{detail.sourceQuote}</blockquote>}
      {detail?.evidence.map(item => <blockquote key={item.id}>{item.quoteSnippet}<small> · {item.sourceStatus} · {item.messageIds?.join(", ")}</small></blockquote>)}
      <label>修正内容<Input.TextArea aria-label="修正记忆内容" autoSize={{ minRows: 3, maxRows: 10 }} maxLength={8000} value={content} onChange={e => setContent(e.target.value)} /></label>
      <p>修改后重新建立检索索引；修改、归档会停用包含此条的旧摘要。删除前可查看关联范围并选择 Wiki 和画像；原聊天、附件与备份保留。</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Button type="primary" disabled={busy || !content.trim()} onClick={() => void change("edit")}>保存修正</Button><Button disabled={busy} onClick={() => setConfirm("archive")}>归档</Button><Button danger disabled={busy} onClick={() => setConfirm("delete")}>删除</Button></div>
    </Modal>
    <Modal title={confirm === "delete" ? "确认删除范围" : "停止召回这条记忆及其派生摘要？"} open={Boolean(confirm)} onCancel={() => !busy && setConfirm(undefined)} confirmLoading={busy} onOk={() => confirm && void change(confirm)} okText="确认" cancelText="取消" okButtonProps={{ danger: confirm === "delete" }}>
      {error && <Alert type="error" title={error} />}
      {confirm === "delete" && detail?.related ? <>
        <p>将删除以下 L2 记忆及依赖它的摘要，避免旧摘要继续传播已删除内容：</p>
        <ul>{detail.related.memories.map(item => <li key={item.id}>{item.summary ? "摘要" : "记忆"}：{item.content}</li>)}</ul>
        <p>以下项目有相同消息来源，可单独勾选。未勾选的现有记录保留。</p>
        {detail.related.profiles.map(item => <div key={item.key}><Checkbox disabled={busy} checked={profileKeys.includes(item.key)} onChange={event => setProfileKeys(keys => event.target.checked ? [...keys, item.key] : keys.filter(key => key !== item.key))}>{item.key}：{item.content}</Checkbox></div>)}
        {detail.related.wikiClaims.map(item => { const key = JSON.stringify([item.pageId, item.claimId]); return <div key={key}><Checkbox disabled={busy} checked={wikiKeys.includes(key)} onChange={event => setWikiKeys(keys => event.target.checked ? [...keys, key] : keys.filter(value => value !== key))}>Wiki · {item.title}：{item.content}</Checkbox></div>; })}
        <p>精确来源：{detail.related.sources.length ? detail.related.sources.map(source => `${source.conversationId}/${source.messageId}`).join("、") : "未记录"}</p>
        <Checkbox disabled={busy || !detail.related.sources.length} checked={preventReplay} onChange={event => setPreventReplay(event.target.checked)}>禁止从上述原消息重新提取记忆</Checkbox>
        <p>该设置影响这些原消息中的所有事实；你在新消息中重新告知的事实仍可学习。</p>
        {detail.related.notes.map(note => <p key={note}>{note}</p>)}
      </> : <p>不会自动删除原始聊天、L0/L1 资料或你保存的导出文件。</p>}
    </Modal>
  </>;
}

export function MemoryExportButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    setBusy(true); setError("");
    try {
      const value = await window.memoryGovernance.export();
      const url = URL.createObjectURL(new Blob([value], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "cyrene-vector-memory.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <><Button loading={busy} onClick={() => void download()}>导出 L0/L1/L2 记忆</Button>{error && <Alert type="error" title={error} />}</>;
}
