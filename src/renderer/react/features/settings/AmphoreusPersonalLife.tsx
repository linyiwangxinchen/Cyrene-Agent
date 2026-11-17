import { Button, Tag } from "antd";
import type { AmphoreusView } from "../../../../shared/amphoreus-world";
import { useTranslation } from "../../i18n";

interface Props {
  world: AmphoreusView;
  location: (id: string) => string;
  time: (at: number, date?: boolean) => string;
  onHistory: () => void;
}

/** This view consumes the same personal knowledge used by chat, rather than public event plans. */
export function AmphoreusPersonalLife({ world, location, time, onHistory }: Props) {
  const { t } = useTranslation();
  const label = (key: string) => t(`settingsPage.amphoreus.${key}`);
  const personal = world.personal;
  const resident = world.residentStates.find((person) => person.id === "cyrene");
  if (!personal && !resident) return null;
  const current = personal?.currentActivity ?? world.activities.find((activity) => activity.residentId === "cyrene");
  const goals = personal?.goals ?? resident?.goals ?? [];
  const activeGoals = goals.filter((goal) => goal.status === "active");
  const recentGoals = [...goals].filter((goal) => goal.status === "completed").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 1);
  const actions = [...(personal?.actions ?? world.personalActions?.filter((action) => action.residentId === "cyrene") ?? [])]
    .sort((a, b) => b.startsAt - a.startsAt).slice(0, 6);
  const experiences = [...(personal?.experiences ?? resident?.memories ?? [])].sort((a, b) => b.at - a.at).slice(0, 4);

  return <section className="cy-amphoreus__personal" aria-label={label("cyreneLife")}>
    <div className="cy-amphoreus__personal-heading"><h2>{label("cyreneLife")}</h2><Button onClick={onHistory}>{label("cyreneHistory")}</Button></div>
    <p className="cy-amphoreus__personal-hint">{label("personalSharingHint")}</p>
    <div className="cy-amphoreus__personal-grid">
      <article className="cy-amphoreus__personal-now">
        <span className="cy-amphoreus__eyebrow">{label("busyWith")}</span>
        <h3>{current?.title ?? label("personalUnsettled")}</h3>
        {current && <small>{location(current.locationId)} · {time(current.startsAt)}–{time(current.endsAt)}</small>}
        <p>{personal?.mood ?? resident?.mood}</p>
        <p><strong>{label("stillOnHerMind")}</strong> {personal?.attention ?? resident?.attention}</p>
      </article>
      <article>
        <h3>{label("smallProjects")}</h3>
        {activeGoals.length === 0 && recentGoals.length === 0 && <p>{label("noProjects")}</p>}
        {[...activeGoals.slice(0, 3), ...recentGoals].map((goal) => <div className="cy-amphoreus__goal" key={goal.id}>
          <span>{goal.title}</span> <Tag>{goal.status === "completed" ? label("projectCompleted") : goal.stage ?? label("open")}</Tag>
          <progress value={goal.progress} max={100} aria-label={goal.title} />
          <small>{goal.reason}</small>
          {goal.status === "active" && goal.nextStep && <p>{label("next")} {goal.nextStep}</p>}
        </div>)}
      </article>
    </div>
    <h3 className="cy-amphoreus__personal-moments-title">{label("lifeMoments")}</h3>
    {experiences.length === 0 ? <p className="cy-amphoreus__personal-hint">{label("noLifeMoments")}</p> : <div className="cy-amphoreus__personal-moments">{experiences.map((memory) => <article key={memory.id}>
      <small>{time(memory.at, true)} · {label(`memoryKind.${memory.kind}`)} · {memory.source}</small><p>{memory.text}</p>
    </article>)}</div>}
    {actions.length > 0 && <details><summary>{label("personalActions")}</summary><div className="cy-amphoreus__personal-moments">{actions.map((action) => <article key={action.id}>
      <div className="cy-amphoreus__meta"><Tag>{label(`actionStatus.${action.status}`)}</Tag><time>{time(action.startsAt, true)}–{time(action.endsAt)}</time></div>
      <h3>{action.title}</h3><p>{action.intent}</p>
      {action.status === "completed" && action.outcome && <p>{action.outcome}</p>}
      {action.status === "completed" && action.artifact && <p><strong>{label("personalKeepsake")}</strong> {action.artifact}</p>}
      {action.status === "interrupted" && action.reason && <p>{action.reason}</p>}
    </article>)}</div></details>}
  </section>;
}
