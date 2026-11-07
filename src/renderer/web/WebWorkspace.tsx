import { lazy, Suspense } from "react";
import { App } from "../react/App";
import { WebConsentGate } from "./WebConsentGate";
import { WebHostDialogs } from "./WebHostDialogs";
import { WebNotifications } from "./WebNotifications";
import { WebAudioOutput } from "./WebAudioOutput";

interface WebWorkspaceProps {
  username?: string;
  onLogout: () => Promise<void>;
}

const AuthenticatedProviders = lazy(async () => {
  // These styles are workspace-only. Keeping them out of the document head
  // avoids downloading ~300 KiB before a remote user has authenticated.
  await Promise.all([
    import("@mantine/core/styles.css"),
    import("../ui/tokens.css"),
    import("../ui/fonts.css"),
    import("../ui/base.css"),
    import("../ui/theme.css"),
    import("../react/styles/reset.css"),
    import("../react/styles/react-root.css"),
  ]);
  const module = await import("../react/app/providers/AppProviders");
  return { default: module.AppProviders };
});

function WorkspaceLoading() {
  return <div id="cyrene-web-loading" role="status" aria-live="polite"><div id="cyrene-web-loading__card"><div id="cyrene-web-loading__spinner" /><strong>正在进入工作区</strong><div>界面资源正在加载，请稍候。</div></div></div>;
}

export function WebWorkspace({ username, onLogout }: WebWorkspaceProps) {
  return <Suspense fallback={<WorkspaceLoading />}><AuthenticatedProviders><WebConsentGate onDecline={onLogout}><div className="cy-web-auth__workspace"><div className="cy-web-auth__bar"><span>{username}</span><button type="button" onClick={() => { void onLogout(); }}>退出</button></div><App /><WebHostDialogs /><WebNotifications /><WebAudioOutput /></div></WebConsentGate></AuthenticatedProviders></Suspense>;
}
