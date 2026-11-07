export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(payload?.error || `HTTP_${response.status}`);
  return payload as T;
}
function jsonRequest(body: unknown): RequestInit { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }
export const webAuth = {
  status: () => requestJson<{ initialized: boolean; authenticated: boolean; username?: string }>("/api/auth/status"),
  challenge: () => requestJson<{ challengeId: string; expiresAt: number; captchaRequired: boolean; captchaImage?: string }>("/api/auth/challenge"),
  bootstrap: async (username: string, password: string, setupToken: string) => {
    await requestJson("/api/auth/bootstrap", { ...jsonRequest({ username, password }), headers: { "Content-Type": "application/json", "X-Cyrene-Setup-Token": setupToken } });
  },
  login: async (username: string, password: string, challenge?: { challengeId?: string; captcha?: string }) => {
    const result = await requestJson<{ username: string }>("/api/auth/login", jsonRequest({ username, password, ...challenge }));
    return result.username;
  },
  logout: async () => { const { stopCoreConnection } = await import("./core-transport"); stopCoreConnection(); await requestJson("/api/auth/logout", { method: "POST" }); },
};
export async function installWebRuntimeGlobals(): Promise<void> {
  const { installSharedBridge } = await import("./core-transport");
  await installSharedBridge();
  const system = window.system;
  if (!system) throw new Error("System bridge unavailable");
  // Open during the originating click, before an asynchronous server round trip
  // loses browser user activation. Mail belongs to the visiting computer.
  system.openExternal = async (url: string) => {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return { ok: false, error: "Invalid URL" };
      if (parsed.protocol === "mailto:") window.open(url, "_self");
      else window.open(url, "_blank", "noopener,noreferrer");
      return { ok: true };
    } catch { return { ok: false, error: "Invalid URL" }; }
  };
}
