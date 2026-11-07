import React from "react";
import { createRoot } from "react-dom/client";

const container = document.getElementById("cyrene-web-root");
if (!container) throw new Error("Root element #cyrene-web-root not found");
void (async () => {
  // Keep the unauthenticated entry light: Mantine/Ant Design styles are only
  // needed once the workspace is unlocked. WebAuthGate loads the provider
  // bundle on the authenticated path, so a slow tunnel does not make the
  // login screen wait for the entire application stylesheet.
  const { WebAuthGate } = await import("./WebAuthGate");
  createRoot(container).render(<React.StrictMode><WebAuthGate /></React.StrictMode>);
})();
