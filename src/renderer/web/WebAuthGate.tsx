import { useEffect, useState } from "react";
import { App } from "../react/App";
import { webAuth } from "./web-runtime";
import { resumeCoreConnection } from "./core-transport";
import { WebHostDialogs } from "./WebHostDialogs";
import { WebNotifications } from "./WebNotifications";
import { WebAudioOutput } from "./WebAudioOutput";
import "./styles.css";

type AuthState = { initialized: boolean; authenticated: boolean; username?: string };
type AuthChallenge = { challengeId: string; expiresAt: number; captchaRequired: boolean; captchaImage?: string };

function authErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return ({
    HTTPS_REQUIRED: "远程登录必须使用 HTTPS，请通过 Nginx/Caddy 的 HTTPS 地址访问。",
    CAPTCHA_REQUIRED: "请填写正确的验证码。",
    LOGIN_RATE_LIMITED: "登录失败次数过多，请稍后再试。",
    INVALID_CREDENTIALS: "账号或密码错误。",
  } as Record<string, string>)[code] || (code || "请求失败");
}

export function WebAuthGate() {
  const [state, setState] = useState<AuthState | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [challenge, setChallenge] = useState<AuthChallenge | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => webAuth.status().then(async status => { if (status.authenticated) await resumeCoreConnection(); setState(status); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "连接服务失败"));
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!state || state.authenticated) return;
    void webAuth.challenge().then((next) => { setChallenge(next); setCaptcha(""); }).catch((cause) => setError(authErrorMessage(cause)));
  }, [state?.initialized, state?.authenticated]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.style.setProperty("--cy-web-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
    resize(); viewport?.addEventListener("resize", resize); window.addEventListener("resize", resize);
    return () => { viewport?.removeEventListener("resize", resize); window.removeEventListener("resize", resize); document.documentElement.style.removeProperty("--cy-web-viewport-height"); };
  }, []);

  if (state?.authenticated) {
    return <div className="cy-web-auth__workspace"><div className="cy-web-auth__bar"><span>{state.username}</span><button type="button" onClick={() => { void webAuth.logout().then(refresh); }}>退出</button></div><App /><WebHostDialogs /><WebNotifications /><WebAudioOutput /></div>;
  }

  const initializing = state !== null && !state.initialized;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (initializing) await webAuth.bootstrap(username, password, setupToken);
      await webAuth.login(username, password, challenge ? { challengeId: challenge.challengeId, captcha } : undefined);
      await refresh();
    } catch (cause) {
      setError(authErrorMessage(cause));
      void webAuth.challenge().then((next) => { setChallenge(next); setCaptcha(""); }).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  return <main className="cy-web-auth"><section className="cy-web-auth__card">
    <p className="cy-web-auth__eyebrow">CYRENE AGENT · WEB</p>
    <h1>{initializing ? "初始化服务" : "登录 Cyrene"}</h1>
    <p>{initializing ? "首次启动需要创建唯一管理员账号。" : "使用管理员账号进入工作区。"}</p>
    {!initializing && window.location.protocol !== "https:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1" && <p className="cy-web-auth__transport-warning" role="alert">当前是远程 HTTP 连接，登录已被保护机制阻止。请改用 HTTPS 地址。</p>}
    <form className="cy-web-auth__form" onSubmit={submit}>
      <label>账号<input autoComplete="username" placeholder="请输入管理员账号" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
      <label>密码<input type="password" autoComplete={initializing ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      {initializing && <label>一次性初始化令牌<input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} required /></label>}
      {!initializing && challenge?.captchaRequired && <label>验证码<div className="cy-web-auth__captcha"><img src={challenge.captchaImage} alt="登录验证码" /><button type="button" onClick={() => { void webAuth.challenge().then(setChallenge); }}>换一张</button></div><input autoComplete="off" inputMode="text" value={captcha} onChange={(event) => setCaptcha(event.target.value.toUpperCase())} required /></label>}
      {error && <p className="cy-web-auth__error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || state === null}>{busy ? "处理中…" : initializing ? "创建并登录" : "登录"}</button>
    </form>
    <p className="cy-web-auth__hint">初始化令牌由 Linux Server 启动日志输出，创建账号后立即失效。</p>
  </section></main>;
}
