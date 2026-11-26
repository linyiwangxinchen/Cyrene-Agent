import type { WorldEventChronology } from "../../../../shared/amphoreus-world";
import { useTranslation } from "../../i18n";

export function AmphoreusEventChronology({ chronology, timezone }: { chronology: WorldEventChronology; timezone: string }) {
  const { t, locale } = useTranslation();
  const label = (key: string) => t(`settingsPage.amphoreus.chronology.${key}`);
  const format = new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
  const time = (at: number) => <time dateTime={new Date(at).toISOString()}>{format.format(at)}</time>;
  const { generatedAt, startsAt, endsAt, resolvedAt, planCanonRevision, resolutionCanonRevision, resolutionSource, reviewedFactIds } = chronology;
  return <>
    {generatedAt !== undefined && <p><strong>{label("generatedAt")}</strong> {time(generatedAt)}{planCanonRevision && <> · {label("canonRevision")} {planCanonRevision}</>}</p>}
    {startsAt !== undefined && endsAt !== undefined && <p><strong>{label("scheduledWindow")}</strong> {time(startsAt)} – {time(endsAt)}</p>}
    {resolvedAt !== undefined && <p><strong>{label("resolvedAt")}</strong> {time(resolvedAt)}{resolutionSource && <> · {label(resolutionSource)}</>}{resolutionCanonRevision && <> · {label("canonRevision")} {resolutionCanonRevision}</>}</p>}
    {resolvedAt === undefined && resolutionSource === "legacy" && <p>{label("legacy")}</p>}
    {!!reviewedFactIds?.length && <p><strong>{label("reviewedFacts")}</strong> {reviewedFactIds.join(" · ")}</p>}
  </>;
}
