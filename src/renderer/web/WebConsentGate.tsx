import { useEffect, useRef, useState, type ReactNode } from "react";
import { CURRENT_DISCLAIMER_VERSION, hasCurrentDisclaimerConsent } from "../../shared/disclaimer";
import { useTranslation } from "../react/i18n";
import { WelcomeGate } from "../react/features/onboarding/WelcomeGate";

export function WebConsentGate({ children, onDecline }: { children: ReactNode; onDecline: () => Promise<void> }) {
  const { t } = useTranslation();
  const [view, setView] = useState<"loading" | "load-error" | "welcome" | "disclaimer" | "ready">("loading");
  const [attempt, setAttempt] = useState(0);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setView("loading");
    void (async () => {
      try {
        if (!window.settings?.getGeneral) throw new Error("Settings unavailable");
        const settings = await window.settings.getGeneral() as { disclaimerAcceptedVersion?: unknown } | undefined;
        if (active) setView(hasCurrentDisclaimerConsent(settings?.disclaimerAcceptedVersion) ? "ready" : "welcome");
      } catch {
        if (active) setView("load-error");
      }
    })();
    return () => { active = false; };
  }, [attempt]);

  async function accept() {
    if (pending.current || !mounted.current) return;
    pending.current = true;
    setAccepting(true);
    setError("");
    try {
      if (!window.settings?.saveGeneral) throw new Error("Settings unavailable");
      const saved = await window.settings.saveGeneral({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION }) as { disclaimerAcceptedVersion?: unknown } | undefined;
      if (!hasCurrentDisclaimerConsent(saved?.disclaimerAcceptedVersion)) throw new Error("Consent not saved");
      if (mounted.current) setView("ready");
    } catch {
      if (mounted.current) setError("onboarding.saveFailed");
    } finally {
      pending.current = false;
      if (mounted.current) setAccepting(false);
    }
  }
  async function decline() {
    if (pending.current || !mounted.current) return;
    pending.current = true;
    try { await onDecline(); }
    catch { if (mounted.current) setError("onboarding.logoutFailed"); }
    finally { pending.current = false; }
  }

  if (view === "ready") return <>{children}</>;
  if (view === "load-error") return <main className="cy-web-auth"><section className="cy-web-auth__card">
    <p role="alert">{t("onboarding.loadFailed")}</p>
    <button type="button" onClick={() => setAttempt(value => value + 1)}>{t("common.retry")}</button>
    <button type="button" onClick={() => { void decline(); }}>{t("onboarding.decline")}</button>
    {error && <p role="alert">{t(error)}</p>}
  </section></main>;
  return <>
    <WelcomeGate view={view} accepting={accepting} error={error} onViewDisclaimer={() => setView("disclaimer")}
      onBack={() => { setError(""); setView("welcome"); }} onAccept={() => { void accept(); }} onQuit={() => { void decline(); }} />
    {view === "welcome" && error && <p className="cy-web-consent-error" role="alert">{t(error)}</p>}
  </>;
}
