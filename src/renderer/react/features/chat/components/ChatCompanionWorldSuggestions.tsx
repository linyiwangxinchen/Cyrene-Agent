import { Alert, Button, Input, Modal, Spin, Tag } from "antd";
import { NotebookPen } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import type { CompanionWorldSuggestion } from "../../../../../shared/companion";
import { normalizeUiLanguage } from "../../../../../shared/ui-language";
import { useTranslation } from "../../../i18n";
import "./ChatCompanionWorldSuggestions.css";

const copy = {
  "zh-CN": {
    trigger: "邀昔涟做件小事",
    noChat: "先开始这段会话，再邀请昔涟",
    scope: "这是一项翁法罗斯里的虚构建议。昔涟会按自己的作息尝试，模拟结束后可在这里查看结果。",
    title: "小事名称",
    intent: "想邀请她做什么",
    example: "比如，请她在观星后写下一段感想。",
    submit: "确认邀请",
    progress: "这段会话的邀请",
    refresh: "刷新进展",
    empty: "还没有邀请。",
    submitted: "已记录这次邀请。",
    unavailable: "昔涟暂时没有合适的安排。内容已保留，可以稍后再试。",
    readError: "暂时无法读取进展。",
    writeError: "暂时无法确认记录结果。重试原内容会沿用这次邀请。",
    retry: "重试邀请",
    schedule: "预计开始",
    withdraw: "撤回邀请",
    withdrawError: "暂时无法确认撤回结果。请刷新进展后再试。",
    withdrawChanged: "这件小事的进展已变，请查看当前状态。",
    status: { planned: "已安排", active: "进行中", completed: "已完成", interrupted: "已中断" },
  },
  en: {
    trigger: "Invite Cyrene to do something",
    noChat: "Start this conversation before inviting Cyrene",
    scope: "This is a fictional suggestion for Amphoreus. Cyrene works it into her routine when she can. You can check the outcome here once the simulation settles it.",
    title: "Activity name",
    intent: "What would you like to invite her to do?",
    example: "For example, write down a thought after stargazing.",
    submit: "Confirm invitation",
    progress: "Invitations in this conversation",
    refresh: "Refresh progress",
    empty: "No invitations yet.",
    submitted: "Invitation recorded.",
    unavailable: "Cyrene has no suitable time right now. Your draft is here when you want to try again.",
    readError: "Progress could not be loaded.",
    writeError: "The invitation could not be confirmed. Retrying the same text will reuse this invitation.",
    retry: "Retry invitation",
    schedule: "Estimated start",
    withdraw: "Withdraw invitation",
    withdrawError: "Withdrawal could not be confirmed. Refresh progress and try again.",
    withdrawChanged: "This activity's progress has changed. Check its current status.",
    status: { planned: "Planned", active: "In progress", completed: "Completed", interrupted: "Interrupted" },
  },
  "ja-JP": {
    trigger: "昔涟に小さな活動を提案",
    noChat: "この会話を始めると、昔涟に提案できます",
    scope: "オンパロスの物語内での提案です。昔涟は都合がつくときに取り組み、その結果が確定するとここで確認できます。",
    title: "活動名",
    intent: "どんなことをしてほしいですか？",
    example: "例：星を眺めたあと、感想をひと言書き留めて。",
    submit: "提案を確定",
    progress: "この会話からの提案",
    refresh: "進捗を更新",
    empty: "まだ提案はありません。",
    submitted: "提案を記録しました。",
    unavailable: "今は都合のつく時間がありません。入力は残っているので、あとで再試行できます。",
    readError: "進捗を読み込めませんでした。",
    writeError: "記録結果を確認できませんでした。同じ内容で再試行すると今回の提案を再利用します。",
    retry: "提案を再試行",
    schedule: "開始予定",
    withdraw: "提案を取り下げる",
    withdrawError: "取り下げの結果を確認できませんでした。進捗を更新してから再試行してください。",
    withdrawChanged: "活動の進捗が変わりました。現在の状態を確認してください。",
    status: { planned: "予定済み", active: "進行中", completed: "完了", interrupted: "中断" },
  },
};

interface WorldSuggestionsProps {
  conversationId: string | null;
  conversationTitle?: string;
}

function SuggestionsForConversation({ conversationId, conversationTitle }: WorldSuggestionsProps) {
  const { locale } = useTranslation();
  const language = normalizeUiLanguage(locale);
  const labels = copy[language];
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [intent, setIntent] = useState("");
  const [actions, setActions] = useState<CompanionWorldSuggestion[]>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"submitted" | "unavailable" | "readError" | "writeError" | "withdrawError" | "withdrawChanged">();
  const inFlight = useRef(false);
  // The main process may have saved an invitation even if its reply was lost.
  const pendingIds = useRef(new Map<string, string>());
  const api = window.companion;
  const timeDisplay = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });

  async function run(operation: () => Promise<void>, error: "readError" | "writeError" | "withdrawError") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      await operation();
    } catch {
      setNotice(error);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function refresh() {
    if (!conversationId) return;
    void run(async () => {
      setActions(await api.getWorldSuggestions(conversationId));
    }, "readError");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const name = title.trim();
    const detail = intent.trim();
    if (!conversationId || !name || !detail || inFlight.current) return;
    void run(async () => {
      const key = JSON.stringify([name, detail]);
      const id = pendingIds.current.get(key) ?? crypto.randomUUID();
      pendingIds.current.set(key, id);
      const result = await api.suggestWorldAction({ conversationId, id, title: name, intent: detail });
      if ("reason" in result) {
        setNotice("unavailable");
        return;
      }
      pendingIds.current.delete(key);
      const { action } = result;
      setActions((current) => [action, ...(current ?? []).filter((item) => item.id !== action.id)]);
      setTitle("");
      setIntent("");
      setNotice("submitted");
    }, "writeError");
  }

  function withdraw(action: CompanionWorldSuggestion) {
    if (!conversationId || action.status !== "planned") return;
    void run(async () => {
      const latest = await api.withdrawWorldSuggestion(conversationId, action.id);
      setActions((current) => current?.flatMap(item => item.id !== action.id ? [item] : latest ? [latest] : []));
      if (latest?.status !== "interrupted") setNotice("withdrawChanged");
    }, "withdrawError");
  }

  if (!api?.getWorldSuggestions || !api.suggestWorldAction || !api.withdrawWorldSuggestion) return null;
  const conversation = conversationTitle?.trim();
  const failure = notice === "readError" || notice === "writeError" || notice === "withdrawError";
  const noticeType = failure ? "error" : notice === "submitted" ? "success" : "info";
  return <>
    <button
      type="button"
      className="cy-composer__agent-button cy-chat-world-suggestions-trigger"
      disabled={!conversationId}
      title={conversationId ? labels.trigger : labels.noChat}
      aria-haspopup="dialog"
      onClick={() => { setOpen(true); refresh(); }}
    >
      <NotebookPen size={15} aria-hidden="true" />
      <span>{labels.trigger}</span>
    </button>
    <Modal open={open} title={labels.trigger} centered width={510} footer={null}
      onCancel={() => setOpen(false)} destroyOnHidden>
      <div className="cy-chat-world-suggestions" aria-busy={busy}>
        <p className="cy-chat-world-suggestions__description">
          {conversation && <><strong>{conversation}</strong><br /></>}
          {labels.scope}
        </p>
        {notice && <Alert type={noticeType} showIcon title={labels[notice]} />}
        {actions && <form className="cy-chat-world-suggestions__form" onSubmit={submit}>
          <label>{labels.title}<Input value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
          <label>{labels.intent}<Input.TextArea value={intent} placeholder={labels.example} rows={2} maxLength={300}
            disabled={busy} onChange={event => setIntent(event.target.value)} /></label>
          <div>
            <Button type="primary" htmlType="submit" disabled={busy || !title.trim() || !intent.trim()}>
              {notice === "writeError" || notice === "unavailable" ? labels.retry : labels.submit}
            </Button>
          </div>
        </form>}
        <section aria-label={labels.progress}>
          <div className="cy-chat-world-suggestions__header">
            <h3>{labels.progress}</h3>
            <Button size="small" disabled={busy} onClick={refresh}>{labels.refresh}</Button>
          </div>
          {!actions && busy && <Spin />}
          {actions?.length === 0 && <p className="cy-chat-world-suggestions__description">{labels.empty}</p>}
          {!!actions?.length && <div className="cy-chat-world-suggestions__records">
            {actions.map(action => <article className="cy-chat-world-suggestions__record" key={action.id}>
              <div className="cy-chat-world-suggestions__record-title">
                <strong>{action.title}</strong>
                <Tag>{labels.status[action.status]}</Tag>
                {action.status === "planned" && <Button size="small" disabled={busy} onClick={() => withdraw(action)}>{labels.withdraw}</Button>}
              </div>
              {(action.status === "planned" || action.status === "active") && <small>
                {labels.schedule} · <time dateTime={new Date(action.startsAt).toISOString()}>{timeDisplay.format(action.startsAt)}</time>
              </small>}
              {(action.outcome || action.reason) && <p>{action.outcome || action.reason}</p>}
            </article>)}
          </div>}
        </section>
      </div>
    </Modal>
  </>;
}

export function ChatCompanionWorldSuggestions(props: WorldSuggestionsProps) {
  return <SuggestionsForConversation key={props.conversationId} {...props} />;
}
