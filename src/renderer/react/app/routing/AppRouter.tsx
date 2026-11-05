import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { SettingsSection } from "../../features/settings/AppearanceSettingsPage";
import { resolveSettingsDestination } from "./settingsNavigation";
import "./AppRouter.css";

// Chat and settings share a large dependency graph, but only one view is visible
// at a time. Keep settings out of the first workspace chunk and load each view
// when it is actually selected.
const ChatPage = lazy(() => import("../../features/chat/pages/ChatPage").then(module => ({ default: module.ChatPage })));
const AppearanceSettingsPage = lazy(() => import("../../features/settings/AppearanceSettingsPage").then(module => ({ default: module.AppearanceSettingsPage })));

function RouterLoading() {
  return <div className="cy-app-router__loading" role="status" aria-live="polite">正在加载页面…</div>;
}

export function AppRouter() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  const [scheduledTasksNavigation, setScheduledTasksNavigation] = useState(0);
  const [musicSettingsNavigation, setMusicSettingsNavigation] = useState(0);

  useEffect(() => window.settings?.onSwitchSection?.((requestedSection) => {
    const destination = resolveSettingsDestination(requestedSection);
    if (destination.kind === "scheduledTasks") {
      setSettingsOpen(false);
      setScheduledTasksNavigation((revision) => revision + 1);
      return;
    }
    setSettingsSection(destination.section);
    setMusicSettingsNavigation((revision) => revision + (destination.openMusicModal ? 1 : 0));
    setSettingsOpen(true);
  }), []);

  const openSettings = useCallback(() => {
    setSettingsSection("appearance");
    setSettingsOpen(true);
  }, []);

  return (
    <Suspense fallback={<RouterLoading />}>
      <div className="cy-app-router">
        <div
          className={`cy-app-router__view ${settingsOpen ? "is-hidden" : ""}`}
          aria-hidden={settingsOpen}
          inert={settingsOpen}
        >
          <ChatPage onOpenSettings={openSettings} scheduledTasksNavigation={scheduledTasksNavigation} />
        </div>
        {settingsOpen && (
          <div className="cy-app-router__view">
            <AppearanceSettingsPage
              section={settingsSection}
              onSelectSection={setSettingsSection}
              onBackToWorkspace={() => setSettingsOpen(false)}
              musicSettingsNavigation={musicSettingsNavigation}
            />
          </div>
        )}
      </div>
    </Suspense>
  );
}
