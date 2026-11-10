import { Button, Tag } from "antd";
import { useState } from "react";
import type { AmphoreusView } from "../../../../shared/amphoreus-world";
import type { XilianLocation } from "../../../../shared/xilian-world";
import { useTranslation } from "../../i18n";

export function AmphoreusMap({ world, locations, onHistory }: { world: AmphoreusView; locations: readonly XilianLocation[]; onHistory(id: string): void }) {
  const { t } = useTranslation();
  const label = (key: string) => t(`settingsPage.amphoreus.${key}`);
  const [selected, setSelected] = useState("okhema");
  const nodes = locations.map((place, i) => {
    const angle = ((i - 1) * 2 * Math.PI / (locations.length - 1)) - Math.PI / 2;
    return { ...place, x: i ? 50 + Math.sin(angle) * 37 : 50, y: i ? 50 + Math.cos(angle) * 39 : 50 };
  });
  const place = locations.find((p) => p.id === selected)!;
  const state = world.places.find((p) => p.id === selected)!;
  const people = world.activities.filter((a) => a.locationId === selected);
  return <section aria-label={label("places")}>
    <p>{label("mapHint")}</p>
    <div className="cy-amphoreus__map">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{world.routes.map((route) => {
        const from = nodes.find((n) => n.id === route.from)!, to = nodes.find((n) => n.id === route.to)!;
        return <line key={route.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
      })}</svg>
      {nodes.map((node) => <button key={node.id} type="button" aria-pressed={selected === node.id} style={{ left: `${node.x}%`, top: `${node.y}%` }} onClick={() => setSelected(node.id)}>{node.name}<small>{label(`access.${world.places.find((p) => p.id === node.id)!.access}`)}</small></button>)}
    </div>
    <article className="cy-amphoreus__place-detail" aria-live="polite">
      <h3>{place.name}</h3><p>{place.description}</p>
      <div className="cy-amphoreus__meta"><Tag>{label(`access.${state.access}`)}</Tag><span>{label("facilities")}：{label(`condition.${state.condition < 35 ? "poor" : state.condition < 70 ? "recovering" : "stable"}`)}</span><span>{label("supplies")}：{label(`suppliesLevel.${state.supplies < 30 ? "low" : state.supplies < 65 ? "enough" : "plenty"}`)}</span></div>
      <p>{state.note}</p><small>{label("hereNow")} {people.map((p) => world.residents.find((r) => r.id === p.residentId)!.name).join(" · ") || label("noResident")}</small>
      <p>{label("routes")}</p><div className="cy-amphoreus__routes">{world.routes.filter((r) => r.from === selected || r.to === selected).map((r) => <span key={r.id}>{locations.find((p) => p.id === (r.from === selected ? r.to : r.from))!.name} · {r.minutes} {label("minutes")}</span>)}</div>
      <Button onClick={() => onHistory(selected)}>{label("placeHistory")}</Button>
    </article>
  </section>;
}
