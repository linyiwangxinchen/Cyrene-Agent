import { useState } from "react";
import { Alert, Button, Input, Modal } from "antd";
import type { MemoryEditCommand, MemoryExplanation } from "../../../../shared/memory-governance";

export function MemoryRecordActions({ id, onChanged }: { id: string; onChanged(): Promise<void> }) {
  const [detail, setDetail] = useState<MemoryExplanation>();
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [confirm, setConfirm] = useState<"archive" | "delete">();
  async function open() {
    setBusy(true); setError(""); setWarning("");
    try { const result = await window.memoryGovernance.explain(id); setDetail(result); setContent(result.content); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function change(action: MemoryEditCommand["action"]) {
    if (!detail) return;
    setBusy(true); setError("");
    try {
      const result = await window.memoryGovernance.change({ id, expectedContent: detail.content, action, ...(action === "edit" ? { content } : {}) } as MemoryEditCommand);
      if (result.warning) setWarning(result.warning);
      await onChanged(); setConfirm(undefined);
      if (!result.warning) setDetail(undefined);
      else if (action === "edit") setDetail({ ...detail, content });
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <><Button size="small" loading={busy} onClick={() => void open()}>来源与管理</Button>{error && !detail && <Alert type="error" title={error} />}
    <Modal title="记忆来源与管理" open={Boolean(detail)} onCancel={() => !busy && setDetail(undefined)} footer={null}>
      {error && <Alert type="error" title={error} />}{warning && <Alert type="warning" title={warning} />}
      <p>来源会话：{detail?.conversationId || "历史记录未保留来源"}</p>
      <p>提取置信度：{detail?.confidence == null ? "原记录未保存，不补造评分" : detail.confidence}</p>
      {detail?.sourceQuote && <blockquote>{detail.sourceQuote}</blockquote>}
      {detail?.evidence.map(item => <blockquote key={item.id}>{item.quoteSnippet}<small> · {item.sourceStatus} · {item.messageIds?.join(", ")}</small></blockquote>)}
      <label>修正内容<Input.TextArea aria-label="修正记忆内容" autoSize={{ minRows: 3, maxRows: 10 }} maxLength={8000} value={content} onChange={e => setContent(e.target.value)} /></label>
      <p>修改后重新建立检索索引；修改、归档会停用包含此条的旧摘要。删除同时删除相关摘要及索引。原对话和手动备份仍需在各自入口删除。</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Button type="primary" disabled={busy || !content.trim()} onClick={() => void change("edit")}>保存修正</Button><Button disabled={busy} onClick={() => setConfirm("archive")}>归档</Button><Button danger disabled={busy} onClick={() => setConfirm("delete")}>删除</Button></div>
    </Modal>
    <Modal title={confirm === "delete" ? "删除这条记忆及其派生摘要？" : "停止召回这条记忆及其派生摘要？"} open={Boolean(confirm)} onCancel={() => setConfirm(undefined)} confirmLoading={busy} onOk={() => confirm && void change(confirm)} okText="确认" cancelText="取消" okButtonProps={{ danger: confirm === "delete" }}><p>不会自动删除原始聊天、L0/L1 资料或你保存的导出文件。</p></Modal>
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
