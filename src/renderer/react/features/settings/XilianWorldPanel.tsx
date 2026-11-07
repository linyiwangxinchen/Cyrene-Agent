import { useEffect, useState } from "react";
import { Alert, Button, Spin, Tabs, Tag } from "antd";
import { getXilianLocation, XILIAN_WORLD_ARCS, type XilianWorldView } from "../../../../shared/xilian-world";
import "./xilian-world-panel.css";

export function XilianWorldPanel() {
  const [view, setView] = useState<XilianWorldView>();
  const [activeTab, setActiveTab] = useState("today");
  const [error, setError] = useState("");

  async function reload() {
    setError("");
    const getWorld = window.companion?.getWorld;
    if (typeof getWorld !== "function") { setError("当前版本没有涟界查询接口，请重启应用。"); return; }
    try { setView(await getWorld()); } catch (reason) { setError(String(reason)); }
  }

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const eventStatusLabel = (status: XilianWorldView["timeline"][number]["status"]) => {
    if (status === "active") return "正在进行";
    if (status === "interrupted") return "中途停下";
    if (status === "planned") return "准备开始";
    return "已完成";
  };

  const locationName = (id: string) => getXilianLocation(id)?.name ?? id;
  const arc = view ? XILIAN_WORLD_ARCS[view.state.activeArcId] : undefined;

  return <section className="cy-settings-section cy-xilian-world" aria-label="涟界">
    <div className="cy-settings-section__heading"><h2>涟界</h2><p>昔涟自己的世界。她会在这里生活、工作、休息、和朋友见面，也会把值得留下的日子写进涟宝的小日记。</p></div>
    {error && <Alert type="error" showIcon title={error} action={<Button onClick={() => void reload()}>重新加载</Button>} />}
    {!view ? (!error && <Spin />) : <>
      <div className="cy-xilian-world__status"><Tag color="blue">{arc?.title ?? view.state.activeArcId}</Tag><Tag>第 {view.state.dayIndex} 天</Tag><Tag>现在在 · {locationName(view.state.currentLocationId)}</Tag><Button size="small" onClick={() => void reload()}>刷新涟界</Button></div>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        { key: "today", label: "今天", children: <div className="cy-xilian-world__body">
          <div className="cy-xilian-world__current"><strong>{view.state.currentActivity?.activityTitle ?? "今天还没有开始记录"}</strong><span>{view.state.currentActivity?.detail ?? view.state.currentActivity?.summary ?? "她会在下一次生活推进时开始今天的记录。"}</span>{view.state.currentActivity?.outcome && <small>目前结果：{view.state.currentActivity.outcome}</small>}{view.state.nextPlannedEvent && <small>接下来：{view.state.nextPlannedEvent.activityTitle}</small>}</div>
          <div className="cy-xilian-world__goals">{view.state.goals.map(goal => <div key={goal.id}><strong>{goal.title}</strong><span>{goal.progress} / {goal.target} · {goal.stage === "completed" ? "已完成" : goal.stage === "paused" ? "已暂停" : "进行中"}</span><div className="cy-xilian-world__bar"><i style={{ width: `${Math.min(100, goal.progress / goal.target * 100)}%` }} /></div></div>)}</div>
          <div className="cy-xilian-world__timeline">{view.timeline.length === 0 ? <p>今天还没有已完成的生活记录。</p> : view.timeline.slice().reverse().map(event => <article key={event.id}><div className="cy-xilian-world__event-meta"><Tag>{locationName(event.locationId)}</Tag><Tag>{eventStatusLabel(event.status)}</Tag><time>{new Date(event.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><h3>{event.activityTitle}</h3><p>{event.detail ?? event.summary}</p>{event.outcome && <small>结果：{event.outcome}</small>}{event.participants?.length ? <small>一起：{event.participants.join("、")}</small> : null}</article>)}</div>
        </div> },
        { key: "diary", label: "涟宝的小日记", children: <div className="cy-xilian-world__diary">{view.diary.length === 0 ? <p>今天还没有写下日记。</p> : view.diary.slice().reverse().map(entry => <article key={entry.id}><div className="cy-xilian-world__event-meta"><Tag>{locationName(entry.locationId)}</Tag><time>{new Date(entry.writtenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><h3>{entry.title}</h3><p>{entry.text}</p><small>那时的心情：{entry.mood}</small></article>)}</div> },
        { key: "places", label: "世界里的地方", children: <div className="cy-xilian-world__places">{view.locations.map(location => <article key={location.id}><h3>{location.name}</h3><p>{location.description}</p><small>{location.tags.join(" · ")}</small></article>)}</div> },
      ]} />
      <p className="cy-xilian-world__notice">涟界里的居民、地点和经历都属于昔涟的虚拟人生；这里不会把服务器记录说成用户的现实经历。</p>
    </>}
  </section>;
}
