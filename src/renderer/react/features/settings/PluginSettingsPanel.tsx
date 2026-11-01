import { PluginModePanel } from "../chat/components/PluginModePanel";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginOverview } from "../../../../shared/plugin-management";
import "./PluginSettingsPanel.css";

export function PluginSettingsPanel() {
  const container = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const changed = useCallback((overview: PluginOverview) => {
    setKey(overview.plugins.filter(p => p.enabled && p.settingsPanel).map(p => `${p.id}:${p.version}:${p.settingsPanel}`).sort().join("|"));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setError("");
    void import("../../../settings/plugin-panels").then(({ mountPluginPanels }) => mountPluginPanels({
      containers: { plugins: container.current }, signal: controller.signal,
    })).then(cleanup => { if (controller.signal.aborted) cleanup(); else dispose = cleanup; })
      .catch(() => { if (!controller.signal.aborted) setError("插件配置页加载失败，请重新打开设置或刷新插件列表。"); });
    return () => { controller.abort(); dispose?.(); };
  }, [key]);
  return <div className="cy-settings-plugin-panel"><PluginModePanel onOverviewChange={changed} />
    {error && <p role="alert">{error}</p>}
    <div ref={container} className="plugin-panels cy-settings-plugin-config" />
  </div>;
}
