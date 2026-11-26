import { useState } from "react";
import type { CompanionReference } from "../../../../../shared/companion-references";
import { useTranslation } from "../../../i18n";

const copy = {
  "zh-CN": {
    title: "本轮参考了什么",
    provided: "本轮提供给模型的资料",
    appeared: "原句出现在回复中",
    history: "查阅过的旧聊天",
    open: "打开来源会话",
    unavailable: "无法打开来源会话。",
    topics: { length: "平时回复短一点", questions: "少用问句收尾", nicknames: "少用昵称", flourishes: "说话自然一点", support: "倾诉时先听我说" },
  },
  en: {
    title: "References for this reply",
    provided: "Context provided to the model for this reply",
    appeared: "The wording appears in the reply",
    history: "Earlier chat consulted",
    open: "Open source chat",
    unavailable: "The source chat could not be opened.",
    topics: { length: "Shorter everyday replies", questions: "Fewer questions at the end", nicknames: "Fewer nicknames", flourishes: "More natural wording", support: "Listen first when I vent" },
  },
  "ja-JP": {
    title: "この返答の参考情報",
    provided: "この返答でモデルに渡した情報",
    appeared: "返答に同じ言い回しがあります",
    history: "参照した過去の会話",
    open: "元の会話を開く",
    unavailable: "元の会話を開けませんでした。",
    topics: { length: "普段は短めに返す", questions: "質問で終える回数を減らす", nicknames: "愛称を控える", flourishes: "自然な言い方をする", support: "まず話を聞く" },
  },
};

export function AssistantCompanionReferences({ references }: { references?: readonly CompanionReference[] }) {
  const { locale } = useTranslation();
  const [error, setError] = useState(false);
  if (!references?.length) return null;
  const labels = copy[locale === "en" || locale === "ja-JP" ? locale : "zh-CN"];
  const store = (window as typeof window & {
    chatStore?: {
      get?: (conversationId: string) => Promise<unknown>;
      openInReactChatWindow?: (conversationId: string) => Promise<unknown>;
    };
  }).chatStore;
  const openSource = async (conversationId: string) => {
    setError(false);
    try {
      if (store?.get && !await store.get(conversationId)) { setError(true); return; }
      if (await store?.openInReactChatWindow?.(conversationId) === false) setError(true);
    } catch { setError(true); }
  };
  return <details className="cy-companion-references">
    <summary>{labels.title}</summary>
    <p>{labels.provided}</p>
    <ul>{references.map(item => {
      const label = item.kind === "preference" ? labels.topics[item.topic]
        : item.kind === "conversation" ? item.title : item.kind === "chat-history" ? labels.history : item.quote;
      return <li key={JSON.stringify([item.kind, item.conversationId, item.userTurnId, label])}>
        <span>{label}</span>
        {item.kind === "expression" && item.appeared && <small> · {labels.appeared}</small>}
        {store?.openInReactChatWindow && <button type="button" onClick={() => void openSource(item.conversationId)}>{labels.open}</button>}
      </li>;
    })}</ul>
    {error && <p role="alert">{labels.unavailable}</p>}
  </details>;
}
