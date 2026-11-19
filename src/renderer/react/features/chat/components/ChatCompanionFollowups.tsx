import { Alert, Button, Input, Modal, Spin, Tag, type InputRef } from "antd";
import { CalendarClock } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import type { CompanionCommand, CompanionFollowup, CompanionSnapshot } from "../../../../../shared/companion";
import { normalizeUiLanguage } from "../../../../../shared/ui-language";
import { useTranslation } from "../../../i18n";
import "./ChatCompanionFollowups.css";

const copy = {
  "zh-CN": {
    title: "约个时间再聊", start: "先开始这段会话，再约定跟进", currentChat: "当前会话",
    scope: "跟进会回到这段会话。到达最早时间后，昔涟会在符合勿扰和渠道设置时关心一次。",
    prerequisites: "跟进需要开启主动聊天和主动关怀，并恢复关系模拟。可以先保存约定。",
    topic: "跟进事项", earliest: "最早可跟进时间（本地时间）", example: "例如：论文答辩",
    confirm: "确认跟进", reschedule: "重新约时间", saveTime: "确认新时间", discard: "取消编辑",
    complete: "标记完成", pause: "暂时不聊", cancel: "以后别问", reload: "重新加载",
    empty: "这段会话暂无跟进事项。", invalidTime: "请选择未来的时间。",
    readError: "无法读取跟进事项。", writeError: "未能保存跟进，请重载后重试。",
    saved: "已保存跟进设置。", asked: "上次关心",
    status: { active: "等待合适时间", awaiting_reply: "已关心，等待回复", completed: "已完成", paused: "已暂停", cancelled: "已取消" },
  },
  en: {
    title: "Follow up later", start: "Start this conversation before scheduling a follow-up", currentChat: "Current conversation",
    scope: "The follow-up returns to this conversation. After the earliest time, Cyrene can check in once when quiet hours and channel settings allow.",
    prerequisites: "Follow-ups require proactive chat, proactive care, and active relationship simulation. You can save the plan now.",
    topic: "Follow-up topic", earliest: "Earliest follow-up time (local time)", example: "For example, thesis defense",
    confirm: "Confirm follow-up", reschedule: "Reschedule", saveTime: "Confirm new time", discard: "Stop editing",
    complete: "Mark complete", pause: "Pause for now", cancel: "Don't ask again", reload: "Reload",
    empty: "No follow-ups in this conversation yet.", invalidTime: "Choose a future time.",
    readError: "Could not load follow-ups.", writeError: "Could not save the follow-up. Reload and try again.",
    saved: "Follow-up settings saved.", asked: "Last check-in",
    status: { active: "Waiting for a suitable time", awaiting_reply: "Checked in, awaiting reply", completed: "Completed", paused: "Paused", cancelled: "Cancelled" },
  },
  "ja-JP": {
    title: "あとで話す約束", start: "この会話を始めてから、あとで話す約束を設定できます", currentChat: "現在の会話",
    scope: "この会話で話題を取り上げます。指定時刻以降、通知を控える時間帯とチャンネルの設定に従って、昔涟が一度だけ声をかけます。",
    prerequisites: "フォローアップには、自発的なチャットと気遣いを有効にし、関係シミュレーションを再開する必要があります。約束は先に保存できます。",
    topic: "話題", earliest: "声をかけてよい日時（現地時間）", example: "例：論文審査",
    confirm: "フォローアップを確定", reschedule: "日時を変更", saveTime: "新しい日時を確定", discard: "編集をやめる",
    complete: "完了にする", pause: "一時停止", cancel: "今後は聞かない", reload: "再読み込み",
    empty: "この会話にはまだフォローアップがありません。", invalidTime: "未来の時刻を選択してください。",
    readError: "フォローアップを読み込めませんでした。", writeError: "保存できませんでした。再読み込みしてからお試しください。",
    saved: "フォローアップの設定を保存しました。", asked: "前回の声かけ",
    status: { active: "適切な時刻を待機中", awaiting_reply: "声かけ済み・返信待ち", completed: "完了", paused: "一時停止中", cancelled: "キャンセル済み" },
  },
};

interface FollowupProps {
  conversationId: string | null;
  conversationTitle?: string;
}

type FollowupCommand =
  | Omit<Extract<CompanionCommand, { type: "followup_save" }>, "expectedRevision">
  | Omit<Extract<CompanionCommand, { type: "followup_status" }>, "expectedRevision">;

type FollowupDraft = { id?: string; topic: string; time: string };

function localTime(timestamp: number): string {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function newDraft(): FollowupDraft {
  return { topic: "", time: localTime(Date.now() + 3_600_000) };
}

function FollowupsForConversation({ conversationId, conversationTitle }: FollowupProps) {
  const { locale } = useTranslation();
  const language = normalizeUiLanguage(locale);
  const labels = copy[language];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const operationInProgress = useRef(false);
  const [snapshot, setSnapshot] = useState<CompanionSnapshot>();
  const [proactiveChatOff, setProactiveChatOff] = useState(false);
  const [draft, setDraft] = useState(newDraft);
  const [error, setError] = useState<"load" | "save" | "time">();
  const [saved, setSaved] = useState(false);
  const timeInput = useRef<InputRef>(null);
  const api = window.companion;

  async function run(operation: () => Promise<void>, failure: "load" | "save") {
    if (operationInProgress.current) return;
    operationInProgress.current = true;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await operation();
    } catch {
      setError(failure);
    } finally {
      operationInProgress.current = false;
      setBusy(false);
    }
  }

  function refresh() {
    return run(async () => {
      const [current, general] = await Promise.all([
        api.get(),
        window.settings?.getGeneral?.().catch(() => undefined),
      ]);
      setSnapshot(current);
      setProactiveChatOff((general as { proactiveChatMode?: unknown } | undefined)?.proactiveChatMode === "off");
    }, "load");
  }

  function change(command: FollowupCommand, resetDraft = false) {
    if (!snapshot) return;
    return run(async () => {
      setSnapshot(await api.update({ ...command, expectedRevision: snapshot.revision }));
      if (resetDraft) setDraft(newDraft());
      setSaved(true);
    }, "save");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!conversationId || !draft.topic.trim() || operationInProgress.current) return;
    const nextEligibleAt = new Date(draft.time).getTime();
    if (!Number.isFinite(nextEligibleAt) || nextEligibleAt <= Date.now()) {
      setError("time");
      return;
    }
    void change({
      type: "followup_save",
      ...(draft.id ? { id: draft.id } : {}),
      conversationId,
      topic: draft.topic.trim(),
      nextEligibleAt,
    }, true);
  }

  function updateStatus(item: CompanionFollowup, status: "completed" | "paused" | "cancelled") {
    if (!conversationId || item.conversationId !== conversationId) return;
    void change({ type: "followup_status", id: item.id, conversationId, status }, draft.id === item.id);
  }

  function edit(item: CompanionFollowup) {
    setSaved(false);
    setError(undefined);
    const at = item.nextEligibleAt > Date.now() + 60_000 ? item.nextEligibleAt : Date.now() + 3_600_000;
    setDraft({ id: item.id, topic: item.topic, time: localTime(at) });
    timeInput.current?.focus();
  }

  const followups = snapshot?.followups?.filter(item => item.conversationId === conversationId).sort((a, b) => b.updatedAt - a.updatedAt) ?? [];
  const prerequisitesMissing = snapshot && (snapshot.relationship.paused || !snapshot.relationship.proactiveLifeEnabled || proactiveChatOff);
  const timeDisplay = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });

  if (!api) return null;
  return <>
    <button
      type="button"
      className="cy-composer__agent-button cy-chat-followups-trigger"
      disabled={!conversationId}
      title={conversationId ? labels.title : labels.start}
      aria-haspopup="dialog"
      onClick={() => {
        setDraft(newDraft());
        setSnapshot(undefined);
        setOpen(true);
        void refresh();
      }}
    >
      <CalendarClock size={15} aria-hidden="true" />
      <span>{labels.title}</span>
    </button>
    <Modal
      open={open}
      title={labels.title}
      centered
      width={510}
      footer={null}
      onCancel={() => { if (!operationInProgress.current) setOpen(false); }}
      destroyOnHidden
    >
      <div className="cy-chat-followups">
        <p className="cy-chat-followups__description"><strong>{conversationTitle?.trim() || labels.currentChat}</strong><br />{labels.scope}</p>
        {prerequisitesMissing && <Alert type="info" showIcon title={labels.prerequisites} />}
        {error && <Alert
          type="error"
          showIcon
          title={error === "time" ? labels.invalidTime : error === "load" ? labels.readError : labels.writeError}
          action={error !== "time" && <Button size="small" disabled={busy} onClick={() => void refresh()}>{labels.reload}</Button>}
        />}
        {saved && <p className="cy-chat-followups__description" role="status">{labels.saved}</p>}
        {snapshot ? <>
          <form className="cy-chat-followups__form" onSubmit={submit} aria-busy={busy}>
            <label>{labels.topic}<Input value={draft.topic} placeholder={labels.example} maxLength={200} disabled={busy} onChange={event => setDraft({ ...draft, topic: event.target.value })} /></label>
            <label>{labels.earliest}<Input ref={timeInput} type="datetime-local" min={localTime(Date.now())} value={draft.time} disabled={busy} onChange={event => setDraft({ ...draft, time: event.target.value })} /></label>
            <div className="cy-chat-followups__actions">
              <Button type="primary" htmlType="submit" disabled={busy || !draft.topic.trim() || !draft.time}>{draft.id ? labels.saveTime : labels.confirm}</Button>
              {draft.id && <Button disabled={busy} onClick={() => setDraft(newDraft())}>{labels.discard}</Button>}
            </div>
          </form>
          {followups.length === 0 ? <p className="cy-chat-followups__description">{labels.empty}</p> : <div className="cy-chat-followups__records">
            {followups.map(item => <article className="cy-chat-followups__record" key={item.id}>
              <div className="cy-chat-followups__record-title"><strong>{item.topic}</strong><Tag>{labels.status[item.status]}</Tag></div>
              <small>{labels.earliest} · <time dateTime={new Date(item.nextEligibleAt).toISOString()}>{timeDisplay.format(item.nextEligibleAt)}</time></small>
              {item.lastAskedAt && <small>{labels.asked} · <time dateTime={new Date(item.lastAskedAt).toISOString()}>{timeDisplay.format(item.lastAskedAt)}</time></small>}
              {item.status === "paused" && item.resolutionReason && <small>{item.resolutionReason}</small>}
              <div className="cy-chat-followups__actions">
                <Button size="small" disabled={busy} onClick={() => edit(item)}>{labels.reschedule}</Button>
                {item.status !== "completed" && item.status !== "cancelled" && <>
                  <Button size="small" disabled={busy} onClick={() => updateStatus(item, "completed")}>{labels.complete}</Button>
                  {item.status !== "paused" && <Button size="small" disabled={busy} onClick={() => updateStatus(item, "paused")}>{labels.pause}</Button>}
                  <Button size="small" disabled={busy} onClick={() => updateStatus(item, "cancelled")}>{labels.cancel}</Button>
                </>}
              </div>
            </article>)}
          </div>}
        </> : busy && <Spin />}
      </div>
    </Modal>
  </>;
}

export function ChatCompanionFollowups(props: FollowupProps) {
  return <FollowupsForConversation key={props.conversationId} {...props} />;
}
