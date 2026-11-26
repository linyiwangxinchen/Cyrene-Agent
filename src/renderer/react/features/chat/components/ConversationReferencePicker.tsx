import { Input, Modal } from "antd";
import { MessageSquareText, Search } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatSessionMeta } from "../../../../../shared/chat-types";
import { useTranslation } from "../../../i18n";
import { chatStore } from "../pages/chat-page-bridge";
import "./SidebarSearchDialog.css";

export interface ConversationReferenceChoice {
  id: string;
  title: string;
}

export function ConversationReferencePicker({ conversationId, disabled, selected, onSelect }: {
  conversationId?: string;
  disabled?: boolean;
  selected?: ConversationReferenceChoice;
  onSelect: (source: ConversationReferenceChoice) => void;
}) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<ChatSessionMeta[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      try {
        const store = chatStore();
        if (!store) throw new Error("Conversation list unavailable");
        const list = await store.list({ mode: "chat" });
        if (active) setSessions(list.filter((session) =>
          session.mode === "chat" && !session.purpose && session.id !== conversationId && session.messageCount > 0,
        ).sort((a, b) => b.updatedAt - a.updatedAt));
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => { active = false; };
  }, [conversationId, open]);

  const label = t("composer.conversationReference.label");
  const searchLabel = t("composer.conversationReference.search");
  const defaultTitle = t("sidebar.defaultSessionTitle");
  const searchTerm = query.trim().toLocaleLowerCase();
  const results = sessions?.filter((session) =>
    (session.title || defaultTitle).toLocaleLowerCase().includes(searchTerm),
  ).slice(0, 30);

  return (
    <>
      <button type="button" className="cy-composer__footer-button" aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
        onClick={() => { setQuery(""); setSessions(null); setFailed(false); setOpen(true); }}>
        <MessageSquareText size={16} aria-hidden="true" />
        <span>{label}</span>
      </button>
      <Modal open={open} title={label} centered width={500} footer={null} destroyOnHidden onCancel={() => setOpen(false)}>
        <div className="cy-sidebar-search-dialog">
          <div className="cy-sidebar-search-dialog__heading">{t("composer.conversationReference.hint")}</div>
          <Input
            autoFocus
            allowClear
            prefix={<Search size={16} aria-hidden="true" />}
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <section className="cy-sidebar-search-dialog__results" aria-label={t("sidebar.searchResults")}>
            {results?.length ? (
              <div className="cy-sidebar-search-dialog__list">
                {results.map((session) => {
                  const title = session.title || defaultTitle;
                  const isSelected = selected?.id === session.id;
                  return (
                    <button key={session.id} className={`cy-sidebar-search-dialog__result${isSelected ? " is-active" : ""}`} type="button"
                      aria-pressed={isSelected}
                      onClick={() => { onSelect({ id: session.id, title }); setOpen(false); }}>
                      <MessageSquareText size={15} aria-hidden="true" />
                      <span className="cy-sidebar-search-dialog__copy">
                        <span className="cy-sidebar-search-dialog__title" title={title}>{title}</span>
                      </span>
                      <span className="cy-sidebar-search-dialog__time">
                        {new Date(session.updatedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="cy-sidebar-search-dialog__empty" role={failed ? "alert" : "status"}>
                {failed ? t("composer.conversationReference.loadFailed") : sessions === null
                  ? t("composer.conversationReference.loading")
                  : searchTerm && sessions.length > 0 ? t("sidebar.noSearchResults") : t("composer.conversationReference.empty")}
              </div>
            )}
          </section>
        </div>
      </Modal>
    </>
  );
}
