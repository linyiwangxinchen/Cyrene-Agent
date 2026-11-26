import { Input, Modal } from "antd";
import { MessageSquareText, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatSessionMeta } from "../../../../../shared/chat-types";
import { useTranslation } from "../../../i18n";
import { chatStore } from "../pages/chat-page-bridge";
import "./SidebarSearchDialog.css";

export interface ConversationReferenceChoice {
  id: string;
  title: string;
}

const PAGE_SIZE = 30;

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
  const [actionError, setActionError] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [checking, setChecking] = useState(false);
  const actionVersion = useRef(0);

  useEffect(() => {
    if (!open) return;
    setChecking(false);
    let active = true;
    void (async () => {
      try {
        const store = chatStore();
        if (!store) throw new Error("Conversation list unavailable");
        const list = await store.list({ mode: "chat", forReference: true });
        if (active) setSessions(list.filter((session) =>
          session.mode === "chat" && !session.purpose && session.id !== conversationId,
        ).sort((a, b) => b.updatedAt - a.updatedAt));
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => { active = false; actionVersion.current += 1; };
  }, [conversationId, open]);

  function close() {
    actionVersion.current += 1;
    setChecking(false);
    setOpen(false);
  }

  async function actOnSource(source: ConversationReferenceChoice, view: boolean) {
    const version = ++actionVersion.current;
    setActionError("");
    setChecking(true);
    try {
      const store = chatStore();
      if (!store) throw new Error();
      if (view) {
        if (!store.openInReactChatWindow || await store.openInReactChatWindow(source.id) === false) throw new Error();
      } else if (store.checkConversationReference && !await store.checkConversationReference(source.id, conversationId)) {
        throw new Error();
      }
      if (actionVersion.current !== version) return;
      if (!view) onSelect(source);
      close();
    } catch {
      if (actionVersion.current === version) setActionError(view ? "openFailed" : "unavailable");
    } finally {
      if (actionVersion.current === version) setChecking(false);
    }
  }

  const label = t("composer.conversationReference.label");
  const searchLabel = t("composer.conversationReference.search");
  const defaultTitle = t("sidebar.defaultSessionTitle");
  const searchTerm = query.normalize("NFKC").trim().toLocaleLowerCase();
  const matches = sessions?.filter((session) =>
    (session.title || defaultTitle).normalize("NFKC").toLocaleLowerCase().includes(searchTerm)
      || session.id.toLocaleLowerCase() === searchTerm,
  );
  const results = matches?.slice(0, limit);
  const canOpenSource = !!chatStore()?.openInReactChatWindow;

  return (
    <>
      <button type="button" className="cy-composer__footer-button" aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
        onClick={() => { setQuery(""); setLimit(PAGE_SIZE); setSessions(null); setFailed(false); setActionError(""); setChecking(false); setOpen(true); }}>
        <MessageSquareText size={16} aria-hidden="true" />
        <span>{label}</span>
      </button>
      <Modal open={open} title={label} centered width={500} footer={null} destroyOnHidden onCancel={close}>
        <div className="cy-sidebar-search-dialog">
          <div className="cy-sidebar-search-dialog__heading">{t("composer.conversationReference.hint")}</div>
          <Input
            autoFocus
            allowClear
            prefix={<Search size={16} aria-hidden="true" />}
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            disabled={checking}
            onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); setActionError(""); }}
          />
          {actionError && <div className="cy-sidebar-search-dialog__reference-error" role="alert">{t(`composer.conversationReference.${actionError}`)}</div>}
          <section className="cy-sidebar-search-dialog__results" aria-label={t("sidebar.searchResults")} aria-busy={checking}>
            {results?.length ? (
              <div className="cy-sidebar-search-dialog__list">
                {results.map((session) => {
                  const title = session.title || defaultTitle;
                  const isSelected = selected?.id === session.id;
                  return (
                    <div className="cy-sidebar-search-dialog__reference-row" key={session.id}>
                      <button className={`cy-sidebar-search-dialog__result${isSelected ? " is-active" : ""}`} type="button"
                        aria-pressed={isSelected} disabled={checking}
                        onClick={() => void actOnSource({ id: session.id, title }, false)}>
                        <MessageSquareText size={15} aria-hidden="true" />
                        <span className="cy-sidebar-search-dialog__copy">
                          <span className="cy-sidebar-search-dialog__title" title={title}>{title}</span>
                        </span>
                        <span className="cy-sidebar-search-dialog__time">
                          {new Date(session.updatedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                        </span>
                      </button>
                      {canOpenSource && <button type="button" disabled={checking}
                        className="cy-sidebar-search-dialog__reference-action"
                        onClick={() => void actOnSource({ id: session.id, title }, true)}>{t("composer.conversationReference.view")}</button>}
                    </div>
                  );
                })}
                {matches && matches.length > limit && <button type="button" disabled={checking} className="cy-sidebar-search-dialog__reference-action"
                  onClick={() => setLimit(limit + PAGE_SIZE)}>{t("composer.conversationReference.more")}</button>}
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
