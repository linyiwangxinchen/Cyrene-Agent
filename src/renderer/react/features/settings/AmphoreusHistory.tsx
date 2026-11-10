import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Spin } from "antd";
import type { AmphoreusView, WorldHistoryPage, WorldHistoryQuery } from "../../../../shared/amphoreus-world";
import type { XilianLocation } from "../../../../shared/xilian-world";
import { useTranslation } from "../../i18n";

export function AmphoreusHistory({ world, locations, residentId, locationId, since, onResident, onLocation, onSince }: {
  world: AmphoreusView; locations: readonly XilianLocation[]; residentId: string; locationId: string; since?: number;
  onResident(value: string): void; onLocation(value: string): void; onSince(): void;
}) {
  const { t, locale } = useTranslation();
  const label = (key: string) => t(`settingsPage.amphoreus.${key}`);
  const [page, setPage] = useState<WorldHistoryPage>({ entries: [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const generation = useRef(0), inFlight = useRef(false);
  const load = useCallback(async (cursor?: WorldHistoryQuery) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = generation.current;
    setBusy(true); setError(false);
    try {
      const next = await window.companion.getWorldHistory({ residentId: residentId || undefined, locationId: locationId || undefined, since, limit: 30, ...cursor });
      if (request === generation.current) setPage((old) => ({ ...next, entries: cursor ? [...old.entries, ...next.entries.filter((entry) => !old.entries.some((e) => e.id === entry.id))] : next.entries }));
    } catch { if (request === generation.current) setError(true); }
    finally { if (request === generation.current) { inFlight.current = false; setBusy(false); } }
  }, [residentId, locationId, since]);
  useEffect(() => {
    generation.current++; inFlight.current = false; setPage({ entries: [] }); void load();
    return () => { generation.current++; inFlight.current = false; };
  }, [load]);
  return <section aria-label={label("chronicle")}>
    <div className="cy-amphoreus__filters">
      <label>{label("residents")} <select value={residentId} onChange={(e) => onResident(e.target.value)}><option value="">{label("allResidents")}</option>{world.residents.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label>{label("places")} <select value={locationId} onChange={(e) => onLocation(e.target.value)}><option value="">{label("allPlaces")}</option>{locations.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {since !== undefined && <Button onClick={onSince}>{label("showAllHistory")}</Button>}
    </div>
    <p>{since !== undefined ? label("sinceVisit") : label("historyHint")}</p>
    {error && <Alert type="error" title={label("loadError")} action={<Button onClick={() => void load(page.entries.length ? page.next : undefined)}>{label("retry")}</Button>} />}
    <div className="cy-amphoreus__events">{page.entries.map((entry) => <article key={entry.id}>
      <small><time>{new Intl.DateTimeFormat(locale, { timeZone: world.clock.timezone, dateStyle: "medium", timeStyle: "short" }).format(entry.at)}</time> · {label(`historyKind.${entry.kind}`)}{entry.status ? ` · ${label(`eventStatus.${entry.status}`)}` : ""}</small>
      <h3>{entry.title}</h3><p>{entry.text}</p>
      {entry.details && <details><summary>{label("causes")}</summary>
        <p>{label("intent")}：{entry.details.intent}</p>
        {entry.details.reason && <p>{entry.details.reason}</p>}
        {entry.details.conditions?.map((condition, i) => <p key={i}>{label("requires")}：{condition.kind === "event" ? condition.eventId : `${locations.find((p) => p.id === condition.placeId)?.name ?? condition.placeId} · ${label(condition.field === "supplies" ? "supplies" : "facilities")} ≥ ${condition.minimum}`}</p>)}
        {entry.details.effects?.map((effect, i) => <p key={i}>{label("changed")}：{effect.reason}</p>)}
      </details>}
      <small>{entry.residentIds.map((id) => world.residents.find((r) => r.id === id)?.name ?? id).join(" · ")}{entry.locationId ? ` · ${locations.find((p) => p.id === entry.locationId)?.name ?? entry.locationId}` : ""}</small>
    </article>)}</div>
    {busy && <Spin aria-label={label("loading")} />}
    {!busy && !error && !page.entries.length && <p>{label("noHistory")}</p>}
    {page.next && <Button loading={busy} onClick={() => void load(page.next)}>{label("loadMore")}</Button>}
  </section>;
}
