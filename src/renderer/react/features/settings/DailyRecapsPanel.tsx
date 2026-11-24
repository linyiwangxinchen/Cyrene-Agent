import { useEffect, useState } from "react";
import { Alert, Button, Spin } from "antd";
import type { DailyRecap } from "../../../../shared/companion";
import { useTranslation } from "../../i18n";

export function DailyRecapsPanel() {
  const { t } = useTranslation();
  const [days, setDays] = useState<DailyRecap[]>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let busy = false;
    async function refresh() {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const result = await window.companion.getDailyRecaps();
        if (active) { setDays(result); setFailed(false); }
      } catch { if (active) setFailed(true); }
      finally { busy = false; }
    }
    void refresh();
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [retry]);
  const label = (key: string) => t("settingsPage.amphoreus." + key);
  return <section aria-label={label("recapTitle")}>
    <h2>{label("recapTitle")}</h2>
    {failed && <Alert type="error" title={label("recapError")} action={<Button onClick={() => setRetry(n => n + 1)}>{label("recapReload")}</Button>} />}
    {!failed && !days && <Spin />}
    {days?.length === 0 && <p>{label("recapEmpty")}</p>}
    <div className="cy-amphoreus__events">{days?.map(day => <article key={day.date}>
      <h3><time dateTime={day.date}>{day.date}</time></h3>
      <small>{label("recap_" + day.status)}</small>
      {day.text?.split(/\n+/u).map((line, i) => <p key={i}>{line}</p>)}
      {day.sources.length > 0 && <details><summary>{label("recapSources")} ({day.sources.length})</summary>
        <ul>{day.sources.map((source, i) => <li key={i}>{source.text}</li>)}</ul>
      </details>}
    </article>)}</div>
  </section>;
}
