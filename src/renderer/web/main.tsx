import React from "react";
import { createRoot } from "react-dom/client";
import "@mantine/core/styles.css";
import { installWebRuntimeGlobals } from "./web-runtime";

const container = document.getElementById("cyrene-web-root");
if (!container) throw new Error("Root element #cyrene-web-root not found");
void (async () => {
  await installWebRuntimeGlobals();
  // Theme/App imports read the preload bridge at module evaluation time. Install
  // the Web bridge first so the existing Windows React tree sees real APIs.
  await import("../ui/theme");
  const [{ AppProviders }, { WebAuthGate }] = await Promise.all([
    import("../react/app/providers/AppProviders"),
    import("./WebAuthGate"),
  ]);
  createRoot(container).render(<React.StrictMode><AppProviders><WebAuthGate /></AppProviders></React.StrictMode>);
})();
