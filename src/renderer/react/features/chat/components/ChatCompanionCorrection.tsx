import { Button, Input, Popover } from "antd";
import { MessageSquare } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import { useTranslation } from "../../../i18n";
import { COMPANION_CORRECTION_MAX_LENGTH } from "../../../../../shared/companion";
import "./ChatCompanionCorrection.css";

const copy = {
  "zh-CN": {
    trigger: "纠正回应",
    pending: "已设下次纠正",
    input: "希望怎样调整回应",
    example: "例如，可以先听我讲完，再问我想不想听建议。",
    once: "仅下次回复",
    remember: "在此会话记住",
    clear: "取消下次纠正",
    saved: "已保存到此会话。",
    error: "未能保存。你的文字还在，可以重试。",
  },
  en: {
    trigger: "Correct a reply",
    pending: "Correction ready",
    input: "How should the reply change?",
    example: "For example, let me finish, then ask if I want advice.",
    once: "Next reply only",
    remember: "Remember in this chat",
    clear: "Clear next correction",
    saved: "Saved to this chat.",
    error: "Couldn't save. Your text is here if you'd like to try again.",
  },
  "ja-JP": {
    trigger: "返答を調整",
    pending: "次の返答に調整あり",
    input: "どう返答してほしいですか？",
    example: "例：話を最後まで聞いてから、助言がほしいか聞いて。",
    once: "次の返答だけ",
    remember: "この会話で覚える",
    clear: "次の返答への調整を解除",
    saved: "この会話に保存しました。",
    error: "保存できませんでした。入力は残っているので、再試行できます。",
  },
};

interface ChatCompanionCorrectionProps {
  conversationId: string | null;
  correction: string;
  onCorrectionChange: (text: string) => void;
}

export function ChatCompanionCorrection(props: ChatCompanionCorrectionProps) {
  return <CorrectionPopover key={props.conversationId} {...props} />;
}

function CorrectionPopover({ conversationId, correction, onCorrectionChange }: ChatCompanionCorrectionProps) {
  const { locale } = useTranslation();
  const labels = locale === "en" || locale === "ja-JP" ? copy[locale] : copy["zh-CN"];
  const popupId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const request = useRef<AbortController | null>(null);
  const triggerRef = useRef<ComponentRef<typeof Button>>(null);

  useLayoutEffect(() => () => request.current?.abort(), []);

  const note = draft.trim();
  const saving = status === "saving";
  const valid = note.length > 0 && note.length <= 500;
  const trigger = correction ? labels.pending : labels.trigger;

  function changeOpen(next: boolean) {
    if (next) setDraft(previous => previous || correction);
    setOpen(next);
  }

  function closeDialog() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function applyOnce() {
    if (!valid || saving) return;
    onCorrectionChange(note);
    setDraft("");
    setStatus("idle");
    closeDialog();
  }

  async function saveForConversation() {
    if (!conversationId || !valid || request.current) return;
    const operation = new AbortController();
    request.current = operation;
    setStatus("saving");
    try {
      const api = window.companion;
      if (!api) throw new Error("Companion API unavailable");
      const { revision } = await api.get();
      if (operation.signal.aborted) return;
      await api.update({ type: "repair", note, conversationId, expectedRevision: revision });
      if (operation.signal.aborted) return;
      if (note === correction) onCorrectionChange("");
      setDraft("");
      setStatus("saved");
    } catch {
      if (!operation.signal.aborted) setStatus("error");
    } finally {
      request.current = null;
    }
  }

  const content = (
    <div id={popupId} role="dialog" aria-label={labels.trigger} className="cy-chat-companion-correction" onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeDialog();
    }}>
      <Input.TextArea
        autoFocus={open}
        aria-label={labels.input}
        placeholder={labels.example}
        rows={3}
        maxLength={COMPANION_CORRECTION_MAX_LENGTH}
        value={draft}
        disabled={saving}
        onChange={event => { setDraft(event.target.value); setStatus("idle"); }}
      />
      <div className="cy-chat-companion-correction__actions">
        <Button size="small" type="primary" disabled={!valid || saving} onClick={applyOnce}>{labels.once}</Button>
        {conversationId && <Button size="small" loading={saving} disabled={!valid} onClick={() => void saveForConversation()}>{labels.remember}</Button>}
        {correction && <Button size="small" type="text" disabled={saving} onClick={() => {
          onCorrectionChange("");
          if (draft === correction) setDraft("");
        }}>{labels.clear}</Button>}
      </div>
      {status === "saved" && <div role="status">{labels.saved}</div>}
      {status === "error" && <div role="alert">{labels.error}</div>}
    </div>
  );

  return <Popover open={open} onOpenChange={changeOpen} trigger="click" placement="top" content={content} destroyOnHidden>
    <Button ref={triggerRef} size="small" type="text" icon={<MessageSquare size={14} aria-hidden />}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined}>
      {trigger}
    </Button>
  </Popover>;
}
