import { useEffect, useState } from "react";
import { Alert, Button, Spin, Tabs, Tag } from "antd";
import { getXilianLocation, XILIAN_WORLD_ARCS, type XilianWorldView } from "../../../../shared/xilian-world";
import { useTranslation } from "../../i18n";
import { normalizeTimezoneOptionValue } from "../../../settings/timezone-options";
import type { UserApi } from "../../../settings/shared/types";
import "./xilian-world-panel.css";

const userApi = () => (window as typeof window & { user?: UserApi }).user;

export function XilianWorldPanel() {
  const { t, locale } = useTranslation();
  const [view, setView] = useState<XilianWorldView>();
  const [activeTab, setActiveTab] = useState("today");
  const [error, setError] = useState("");
  const [timezone, setTimezone] = useState("Asia/Shanghai");

  async function reload() {
    setError("");
    const getWorld = window.companion?.getWorld;
    if (typeof getWorld !== "function") { setError(t("settingsPage.cyrene.worldUnavailable")); return; }
    try { setView(await getWorld()); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [t]);

  useEffect(() => {
    let active = true;
    void userApi()?.getProfile().then((profile) => {
      if (active) setTimezone(normalizeTimezoneOptionValue(profile?.timezone));
    }).catch(() => { /* The safe default keeps the panel usable without profile IPC. */ });
    return () => { active = false; };
  }, []);

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return "—";
    try {
      return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(date);
    } catch {
      return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
    }
  };

  const eventStatusLabel = (status: XilianWorldView["timeline"][number]["status"]) => t(`settingsPage.cyrene.worldEventStatus.${status}`);
  const artifactStatusLabel = (status: NonNullable<XilianWorldView["artifacts"]>[number]["status"]) => t(`settingsPage.cyrene.worldArtifactStatus.${status}`);
  const artifactKindLabel = (kind: NonNullable<XilianWorldView["artifacts"]>[number]["kind"]) => t(`settingsPage.cyrene.worldArtifactKind.${kind}`);
  const locationName = (id: string) => getXilianLocation(id)?.name ?? id;
  const arc = view ? XILIAN_WORLD_ARCS[view.state.activeArcId] : undefined;
  const artifacts = view?.artifacts ?? [];

  return <section className="cy-settings-section cy-xilian-world" aria-label={t("settingsPage.cyrene.worldTitle")}>
    <div className="cy-settings-section__heading"><h2>{t("settingsPage.cyrene.worldTitle")}</h2><p>{t("settingsPage.cyrene.worldDescription")}</p></div>
    {error && <Alert type="error" showIcon title={error} action={<Button onClick={() => void reload()}>{t("settingsPage.cyrene.worldReload")}</Button>} />}
    {!view ? (!error && <Spin />) : <>
      <div className="cy-xilian-world__status"><Tag color="blue">{arc?.title ?? view.state.activeArcId}</Tag><Tag>{t("settingsPage.cyrene.worldDay", { day: view.state.dayIndex })}</Tag><Tag>{t("settingsPage.cyrene.worldLocation", { location: locationName(view.state.currentLocationId) })}</Tag><Tag>{view.state.worldDate}</Tag><Button size="small" onClick={() => void reload()}>{t("settingsPage.cyrene.worldReload")}</Button></div>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        { key: "today", label: t("settingsPage.cyrene.worldToday"), children: <div className="cy-xilian-world__body">
          <div className="cy-xilian-world__current"><strong>{view.state.currentActivity?.activityTitle ?? t("settingsPage.cyrene.worldNoActivity")}</strong><span>{view.state.currentActivity?.detail ?? view.state.currentActivity?.summary ?? t("settingsPage.cyrene.worldNoActivityHint")}</span>{view.state.currentActivity?.outcome && <small>{t("settingsPage.cyrene.worldOutcome", { value: view.state.currentActivity.outcome })}</small>}{view.state.nextPlannedEvent && <small>{t("settingsPage.cyrene.worldNext", { value: view.state.nextPlannedEvent.activityTitle })}</small>}</div>
          <div className="cy-xilian-world__goals">{view.state.goals.map(goal => { const target = Math.max(1, goal.target); const progress = Math.max(0, Math.min(100, goal.progress / target * 100)); const stage = t(`settingsPage.cyrene.worldGoalStatus.${goal.stage}`); return <div key={goal.id}><strong>{goal.title}</strong><span>{t("settingsPage.cyrene.worldGoalProgress", { progress: goal.progress, target: goal.target, status: stage })}</span><div className="cy-xilian-world__bar"><i style={{ width: `${progress}%` }} /></div></div>; })}</div>
          <div className="cy-xilian-world__timeline">{view.timeline.length === 0 ? <p>{t("settingsPage.cyrene.worldNoTimeline")}</p> : view.timeline.slice().reverse().map(event => <article key={event.id}><div className="cy-xilian-world__event-meta"><Tag>{locationName(event.locationId)}</Tag><Tag>{eventStatusLabel(event.status)}</Tag><time>{formatTime(event.occurredAt)}</time></div><h3>{event.activityTitle}</h3><p>{event.detail ?? event.summary}</p>{event.outcome && <small>{t("settingsPage.cyrene.worldResult", { value: event.outcome })}</small>}{event.participants?.length ? <small>{t("settingsPage.cyrene.worldTogether", { value: event.participants.join("、") })}</small> : null}</article>)}</div>
        </div> },
        { key: "diary", label: t("settingsPage.cyrene.worldDiary"), children: <div className="cy-xilian-world__diary">{view.diary.length === 0 ? <p>{t("settingsPage.cyrene.worldNoDiary")}</p> : view.diary.slice().reverse().map(entry => <article key={entry.id}><div className="cy-xilian-world__event-meta"><Tag>{locationName(entry.locationId)}</Tag><time>{formatTime(entry.writtenAt)}</time></div><h3>{entry.title}</h3><p>{entry.text}</p><small>{t("settingsPage.cyrene.worldMood", { value: entry.mood })}</small></article>)}</div> },
        { key: "places", label: t("settingsPage.cyrene.worldPlaces"), children: <div className="cy-xilian-world__places">{view.locations.map(location => <article key={location.id}><h3>{location.name}</h3><p>{location.description}</p><small>{location.tags.join(" · ")}</small></article>)}</div> },
      ]} />
      <div className="cy-xilian-world__artifacts"><div className="cy-xilian-world__artifacts-heading"><h3>{t("settingsPage.cyrene.worldArtifacts")}</h3><span>{t("settingsPage.cyrene.worldArtifactsHint")}</span></div>{artifacts.length === 0 ? <p>{t("settingsPage.cyrene.worldNoArtifacts")}</p> : artifacts.slice(0, 12).map(artifact => <article key={artifact.id}><div className="cy-xilian-world__event-meta"><Tag color={artifact.status === "generated" ? "green" : artifact.status === "failed" ? "red" : artifact.status === "generating" ? "blue" : undefined}>{artifactStatusLabel(artifact.status)}</Tag><Tag>{artifactKindLabel(artifact.kind)}</Tag><time>{formatTime(artifact.updatedAt)}</time></div>{artifact.imageModel && <small>{t("settingsPage.cyrene.worldArtifactModel", { model: artifact.imageModel })}</small>}{artifact.errorClass && <small>{t(`settingsPage.cyrene.worldArtifactError.${artifact.errorClass}`)}</small>}</article>)}</div>
      <p className="cy-xilian-world__notice">{t("settingsPage.cyrene.worldNotice")}</p>
    </>}
  </section>;
}
