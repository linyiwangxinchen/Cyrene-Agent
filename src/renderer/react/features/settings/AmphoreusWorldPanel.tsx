import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Spin, Switch, Tabs, Tag } from "antd";
import type { XilianWorldView } from "../../../../shared/xilian-world";
import { useTranslation } from "../../i18n";
import "./amphoreus-world-panel.css";
import type { SettingsSearchItem } from "./settings-search-index";
import { AmphoreusHistory } from "./AmphoreusHistory";
import { AmphoreusMap } from "./AmphoreusMap";

const VISIT_KEY = "cyrene:amphoreus:last-visit";
function lastVisit(): number | undefined { try { const at = Number(localStorage.getItem(VISIT_KEY)); return at > 0 && at < Date.now() ? at : undefined; } catch { return undefined; } }

export function AmphoreusWorldPanel({ searchTarget }: { searchTarget?: SettingsSearchItem } = {}) {
  const { t, locale } = useTranslation();
  const label = (key: string) => t(`settingsPage.amphoreus.${key}`);
  const [view, setView] = useState<XilianWorldView>();
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("today");
  const [activeTab, setActiveTab] = useState("events");
  const [visitedAt] = useState(lastVisit);
  const [historyResident, setHistoryResident] = useState(""), [historyLocation, setHistoryLocation] = useState("");
  const [historySince, setHistorySince] = useState<number>();
  const [preview, setPreview] = useState<{ id: string; dataUrl?: string; error?: boolean }>();
  const openHistory = (residentId = "", locationId = "", since?: number) => { setHistoryResident(residentId); setHistoryLocation(locationId); setHistorySince(since); setActiveTab("chronicle"); };
  useEffect(() => { if (searchTarget) setActiveTab(searchTarget.id.endsWith(".residents") ? "residents" : "events"); }, [searchTarget]);
  const mounted = useRef(false);
  const latest = useRef<XilianWorldView | undefined>(undefined), cursor = useRef<string | undefined>(undefined);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const reload = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const request = (async () => {
      try {
        const update = window.companion.getWorldUpdate ? await window.companion.getWorldUpdate(cursor.current) : undefined;
        const previous = latest.current;
        const next = update ? update.view ?? (previous?.amphoreus && update.clock ? { ...previous, amphoreus: { ...previous.amphoreus, clock: update.clock } } : previous) : await window.companion.getWorld();
        if (mounted.current && next) { cursor.current = update?.cursor; latest.current = next; setView(next); setError(false); }
      } catch { if (mounted.current) setError(true); }
    })();
    inFlight.current = request.finally(() => { inFlight.current = undefined; });
    return inFlight.current;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const recordVisit = () => { try { localStorage.setItem(VISIT_KEY, String(Date.now())); } catch { /* Storage may be unavailable in private mode. */ } };
    const refreshVisible = () => { if (document.visibilityState !== "hidden") void reload(); else recordVisit(); };
    const timer = window.setInterval(refreshVisible, 60_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { mounted.current = false; recordVisit(); window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [reload]);
  async function configure(enabled: boolean) {
    setSaving(true);
    try {
      await window.companion.configureWorld({ narrativeEnabled: enabled });
      await inFlight.current;
      await reload();
    } catch { if (mounted.current) setError(true); }
    finally { if (mounted.current) setSaving(false); }
  }
  async function showArtifact(id: string) {
    setPreview({ id });
    try {
      const result = await window.companion.getWorldArtifact(id);
      if (mounted.current) setPreview((current) => current?.id === id ? { id, ...(result ?? { error: true }) } : current);
    } catch { if (mounted.current) setPreview((current) => current?.id === id ? { id, error: true } : current); }
  }
  const world = view?.amphoreus;
  const location = (id: string) => view?.locations.find((p) => p.id === id)?.name ?? id;
  const resident = (id: string) => world?.residents.find((r) => r.id === id)?.name ?? id;
  const time = (at: number, date = false) => new Intl.DateTimeFormat(locale, { timeZone: world?.clock.timezone ?? "UTC", ...(date ? { month: "2-digit", day: "2-digit" } as const : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  const events = world?.events.filter((event) => filter === "today" ? event.date === world.clock.date : filter === "major" ? event.severity === "major" : true).sort((a, b) => filter === "today" ? a.startsAt - b.startsAt : b.startsAt - a.startsAt) ?? [];

  return <section className="cy-settings-section cy-amphoreus" aria-label={label("title")} data-settings-search-loading={!view && !error ? "true" : "false"}>
    <header className="cy-amphoreus__heading">
      <div><h1>{label("title")}</h1><p>{label("intro")}</p></div>
      <Button onClick={() => void reload()}>{label("refresh")}</Button>
    </header>
    {error && <Alert type="error" showIcon title={label("loadError")} action={<Button onClick={() => void reload()}>{label("retry")}</Button>} />}
    {!view && !error && <Spin aria-label={label("loading")} />}
    {view && !world && <Alert type="info" title={label("unavailable")} />}
    {view && world && <>
      <div className="cy-amphoreus__clock" data-phase={world.clock.phase}>
        <div><span>{world.clock.date} · {world.clock.timezone}</span><strong><time>{world.clock.time}</time></strong><Tag>{label(`phase.${world.clock.phase}`)}</Tag></div>
        <p>{label("clockHint")}</p>
      </div>
      <p className="cy-amphoreus__premise">{world.premise}</p>
      <section className="cy-amphoreus__generation" aria-label={label("narrative")}>
        <div><strong data-settings-search-id="settingsPage.amphoreus.narrative">{label("narrative")}</strong><p>{label("narrativeHint")}</p></div>
        <Switch checked={world.narrativeEnabled} loading={saving} onChange={(enabled) => void configure(enabled)} aria-label={label("narrative")} />
        <div className="cy-amphoreus__generation-status" role="status">
          <Tag color={world.narrative?.status === "success" ? "green" : world.narrative?.status === "failed" ? "orange" : undefined}>{label(`status.${world.narrativeEnabled ? world.narrative?.status ?? "pending" : "disabled"}`)}</Tag>
          {world.narrative?.error && <span>{label(`error.${world.narrative.error}`)}</span>}
          {world.narrative && world.narrative.count > 0 && <span>{label("attempts")} {world.narrative.count}/3</span>}
          {world.lastSuccessfulDate && <span>{label("lastSuccess")} {world.lastSuccessfulDate}</span>}
          <span>{label("dailyBudget")} {world.budget.used}/{world.budget.limit}</span>
        </div>
      </section>
      {visitedAt && <Button className="cy-amphoreus__visit" onClick={() => openHistory("", "", visitedAt)}>{label("sinceVisit")}</Button>}
      {world.gaps.length > 0 && <details><summary>{label("offlineContinuity")}</summary><p>{world.gaps.at(-1)!.summary}</p></details>}
      <Tabs destroyOnHidden activeKey={activeTab} onChange={setActiveTab} items={[
        { key: "events", label: label("events"), children: <>
          <div className="cy-amphoreus__filters" aria-label={label("eventFilter")}>{["today", "recent", "major"].map((key) => <Button key={key} type={filter === key ? "primary" : "default"} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label(key)}</Button>)}</div>
          <div className="cy-amphoreus__events">{events.length === 0 ? <p className="cy-amphoreus__empty">{label("noEvents")}</p> : events.map((event) => <article key={event.id}>
            <div className="cy-amphoreus__meta"><time>{time(event.startsAt, true)}–{time(event.endsAt)}</time><Tag>{location(event.locationId)}</Tag><Tag color={event.status === "active" ? "blue" : undefined}>{label(`eventStatus.${event.status}`)}</Tag>{event.severity === "major" && <Tag color="gold">{label("major")}</Tag>}</div>
            <h3>{event.title}</h3><p>{event.summary}</p>{event.outcome && <p className="cy-amphoreus__outcome"><strong>{label("outcome")}</strong> {event.outcome}</p>}
            <details><summary>{label("causes")}</summary><p>{label("intent")}：{event.intent ?? event.summary}</p>
              {event.conditions?.map((condition, i) => <p key={i}>{label("requires")}：{condition.kind === "event" ? world.events.find((e) => e.id === condition.eventId)?.title ?? label("earlierEvent") : `${location(condition.placeId)} · ${label(condition.field === "supplies" ? "supplies" : "facilities")} ≥ ${condition.minimum}`}</p>)}
              {event.reason && <p>{label("changedBecause")}：{event.reason}</p>}
              {event.effects?.map((effect, i) => <p key={i}>{label("changed")}：{effect.reason}</p>)}
              {world.threads.filter((thread) => thread.eventId === event.id).map((thread) => <p key={thread.id}>{label("next")} {thread.title}：{thread.nextStep}</p>)}
              <Button onClick={() => openHistory("", event.locationId)}>{label("placeHistory")}</Button>
            </details>
            <small>{event.participants.map(resident).join(" · ")} · {label("generated")}</small>
          </article>)}</div>
          <h2 data-settings-search-id="settingsPage.amphoreus.threads">{label("threads")}</h2>
          <div className="cy-amphoreus__grid">{world.threads.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((thread) => <article key={thread.id}><Tag color={thread.status === "resolved" ? "green" : undefined}>{label(thread.status)}</Tag><h3>{thread.title}</h3><p>{thread.summary}</p><small>{label("next")} {thread.nextStep}</small><small>{thread.participants.map(resident).join(" · ")}</small></article>)}</div>
        </> },
        { key: "residents", label: label("residents"), children: <>
          <p data-settings-search-id="settingsPage.amphoreus.residents">{label("residentHint")}</p>
          <div className="cy-amphoreus__grid">{world.residents.map((person) => {
            const activity = world.activities.find((a) => a.residentId === person.id);
            const life = world.residentStates.find((r) => r.id === person.id)!;
            return <article key={person.id}><div className="cy-amphoreus__meta"><Tag>{label(`kind.${person.kind}`)}</Tag>{person.coreflame && <small>{person.coreflame}</small>}</div><h3>{person.name}</h3>
              {activity && <><p><strong>{activity.title}</strong></p><small>{location(activity.locationId)} · {time(activity.startsAt)}–{time(activity.endsAt)} · {label(activity.source === "llm" ? "generated" : "routine")}</small></>}
              <p>{life.mood}</p><p><strong>{label("attention")}</strong> {life.attention}</p>
              <details><summary>{label("personalLife")}</summary>
                {life.goals.map((goal) => <div className="cy-amphoreus__goal" key={goal.id}><span>{goal.title} · {label(goal.status === "completed" ? "resolved" : "open")}</span><progress value={goal.progress} max={100} aria-label={goal.title} /><small>{goal.reason}</small></div>)}
                {life.relations.map((relation) => <p key={relation.residentId}>{resident(relation.residentId)}：{relation.reason}</p>)}
                {life.memories.slice(-5).reverse().map((memory) => <p key={memory.id}><small>{time(memory.at, true)} · {label(`memoryKind.${memory.kind}`)} · {memory.source}</small>{memory.text}</p>)}
                <Button onClick={() => openHistory(person.id)}>{label("personHistory")}</Button>
              </details>
              <details><summary>{label("profile")}</summary><p>{person.identity}</p><p>{person.personality}</p><p>{label("aspiration")} {person.aspiration}</p><p>{person.relations}</p><div className="cy-amphoreus__sources">{world.sources.filter((s) => person.sources.includes(s.id)).map((s) => <a key={s.id} href={s.url} target="_blank" rel="noreferrer">{s.title}</a>)}</div></details>
            </article>;
          })}</div>
        </> },
        { key: "places", label: label("places"), children: <AmphoreusMap world={world} locations={view.locations} onHistory={(id) => openHistory("", id)} /> },
        { key: "chronicle", label: label("chronicle"), children: <AmphoreusHistory world={world} locations={view.locations} residentId={historyResident} locationId={historyLocation} since={historySince} onResident={setHistoryResident} onLocation={setHistoryLocation} onSince={() => setHistorySince(undefined)} /> },
        { key: "diary", label: label("diary"), children: <>
          <p>{label("diaryHint")}</p><div className="cy-amphoreus__events">
            {view.state.currentActivity && <article><Tag color="blue">{label("now")}</Tag><h3>{view.state.currentActivity.activityTitle}</h3><p>{view.state.currentActivity.summary}</p>{view.state.nextPlannedEvent && <small>{label("next")} {view.state.nextPlannedEvent.activityTitle}</small>}</article>}
            {view.diary.map((entry) => <article key={entry.id}><small>{entry.dateKey} · {entry.eventId.startsWith("amphoreus:") ? label("continuation") : label("archive")}</small><h3>{entry.title}</h3><p>{entry.text}</p></article>)}
            {view.diary.length === 0 && <p>{label("noDiary")}</p>}
          </div>
          <h2>{label("artifacts")}</h2>{view.artifacts.length === 0 ? <p>{label("noArtifacts")}</p> : view.artifacts.slice(0, 12).map((a) => <p key={a.id}><Tag>{t(`settingsPage.cyrene.worldArtifactKind.${a.kind}`)}</Tag><Tag>{t(`settingsPage.cyrene.worldArtifactStatus.${a.status}`)}</Tag><time>{time(a.updatedAt, true)}</time>{a.status === "generated" && <Button onClick={() => void showArtifact(a.id)}>{label("preview")}</Button>}</p>)}
        </> },
        { key: "sources", label: label("sources"), children: <><p>{world.premise}</p><p>{label("sourceHint")}</p><div className="cy-amphoreus__events">{world.history.map((entry) => <article key={entry.id}><h3>{entry.title}</h3><p>{entry.summary}</p>{world.sources.filter((source) => entry.sources.includes(source.id)).map((source) => <a key={source.id} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</article>)}</div><details><summary>{label("canonFacts")}</summary>{world.facts.map((fact) => <p key={fact.id}><Tag>{label(fact.scope === "canon" ? "archive" : "continuation")}</Tag>{fact.statement}</p>)}</details><div className="cy-amphoreus__sources">{world.sources.map((s) => <a key={s.id} href={s.url} target="_blank" rel="noreferrer">{s.title} · {label(`sourceKind.${s.kind}`)}</a>)}</div><small>{label("revision")} {world.canonRevision}</small></> },
      ]} />
    </>}
    <Modal open={!!preview} footer={null} onCancel={() => setPreview(undefined)} title={label("preview")} destroyOnHidden>
      {preview?.error ? <p>{label("previewUnavailable")}</p> : preview?.dataUrl ? <img src={preview.dataUrl} alt={label("artifactAlt")} className="cy-amphoreus__preview" /> : <Spin aria-label={label("loading")} />}
    </Modal>
  </section>;
}
