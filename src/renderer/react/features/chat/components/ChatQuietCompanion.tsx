import { Button, Checkbox, Modal, Radio } from "antd";
import { Pause, Timer } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { normalizeUiLanguage } from "../../../../../shared/ui-language";
import { useCyreneAvatar } from "../../../hooks/useCyreneAvatar";
import { useTranslation } from "../../../i18n";
import "./ChatQuietCompanion.css";

const copy = {
  "zh-CN": {
    title: "安静共处", duration: "共处多久", minutes: (value: number) => `${value} 分钟`,
    sound: "结束时播放提示音", start: "开始共处", pause: "暂停", resume: "继续", end: "结束",
    running: "昔涟安静陪着你", paused: "共处已暂停", completed: "这段共处结束了",
    again: "再来一段", dismiss: "关闭提示", remaining: "剩余时间",
  },
  en: {
    title: "Quiet company", duration: "Duration", minutes: (value: number) => `${value} min`,
    sound: "Play a chime at the end", start: "Start", pause: "Pause", resume: "Resume", end: "End",
    running: "Cyrene is here with you", paused: "Quiet company paused", completed: "Quiet company complete",
    again: "Start another", dismiss: "Dismiss", remaining: "Time remaining",
  },
  "ja-JP": {
    title: "静かに一緒に過ごす", duration: "一緒に過ごす時間", minutes: (value: number) => `${value} 分`,
    sound: "終了時に音を鳴らす", start: "始める", pause: "一時停止", resume: "再開", end: "終了",
    running: "昔涟が静かにそばにいます", paused: "一時停止中", completed: "一緒に過ごす時間が終わりました",
    again: "もう一度", dismiss: "閉じる", remaining: "残り時間",
  },
};

const durations = [10, 20, 40];

type QuietSession =
  | { status: "idle" }
  | { status: "running"; startedAt: number; deadlineAt: number }
  | { status: "paused"; remainingMs: number }
  | { status: "completed" };

function closeAudio(context: AudioContext | null) {
  if (context && context.state !== "closed") void context.close().catch(() => {});
}

function openAudio(): AudioContext | null {
  try {
    const context = new AudioContext();
    // Invoke resume inside the Start click so the browser sees user activation.
    if (context.state === "suspended") void context.resume().catch(() => {});
    return context;
  } catch {
    return null;
  }
}

function playChime(context: AudioContext, release: () => void) {
  if (context.state !== "running") {
    release();
    return;
  }
  try {
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    const at = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(523.25, at);
    volume.gain.setValueAtTime(0.001, at);
    volume.gain.exponentialRampToValueAtTime(0.06, at + 0.025);
    volume.gain.exponentialRampToValueAtTime(0.001, at + 0.36);
    oscillator.connect(volume);
    volume.connect(context.destination);
    oscillator.onended = release;
    oscillator.start(at);
    oscillator.stop(at + 0.37);
  } catch {
    release();
  }
}

/** Lives at the chat page so navigating within it does not drop an active timer. */
export function useQuietCompanion() {
  const [session, setSession] = useState<QuietSession>({ status: "idle" });
  const current = useRef(session);
  const audio = useRef<AudioContext | null>(null);

  const update = useCallback((next: QuietSession) => {
    current.current = next;
    setSession(next);
  }, []);

  const finish = useCallback(() => {
    update({ status: "completed" });
    const context = audio.current;
    if (!context) return;
    playChime(context, () => {
      if (audio.current !== context) return;
      audio.current = null;
      closeAudio(context);
    });
  }, [update]);

  useEffect(() => {
    if (session.status !== "running") return;
    let timeout: number | undefined;
    const sync = () => {
      window.clearTimeout(timeout);
      if (current.current !== session) return;
      const remainingMs = session.deadlineAt - Date.now();
      if (remainingMs <= 0) finish();
      else timeout = window.setTimeout(sync, remainingMs);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  }, [finish, session]);

  useEffect(() => () => {
    closeAudio(audio.current);
    audio.current = null;
  }, []);

  function start(minutes: number, sound: boolean) {
    if (current.current.status !== "idle" || !durations.includes(minutes)) return;
    audio.current = sound ? openAudio() : null;
    const startedAt = Date.now();
    update({ status: "running", startedAt, deadlineAt: startedAt + minutes * 60_000 });
  }

  function pause() {
    const active = current.current;
    if (active.status !== "running") return;
    const remainingMs = active.deadlineAt - Date.now();
    if (remainingMs <= 0) finish();
    else update({ status: "paused", remainingMs });
  }

  function resume() {
    const paused = current.current;
    if (paused.status !== "paused") return;
    const context = audio.current;
    if (context?.state === "suspended") void context.resume().catch(() => {});
    const startedAt = Date.now();
    update({ status: "running", startedAt, deadlineAt: startedAt + paused.remainingMs });
  }

  function end() {
    closeAudio(audio.current);
    audio.current = null;
    update({ status: "idle" });
  }

  return { active: session.status !== "idle", session, start, pause, resume, end };
}

function useRemainingTime(session: QuietSession): string {
  const [observedAt, setObservedAt] = useState(Date.now);
  useEffect(() => {
    if (session.status !== "running") return;
    let timeout: number | undefined;
    const tick = () => {
      window.clearTimeout(timeout);
      const now = Date.now();
      setObservedAt(now);
      const remainingMs = session.deadlineAt - now;
      if (remainingMs > 0) timeout = window.setTimeout(tick, remainingMs % 1000 || 1000);
    };
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [session]);

  const remainingMs = session.status === "running"
    ? session.deadlineAt - Math.max(session.startedAt, observedAt)
    : session.status === "paused" ? session.remainingMs : 0;
  const seconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export function ChatQuietCompanion({ companion }: { companion: ReturnType<typeof useQuietCompanion> }) {
  const { locale } = useTranslation();
  const labels = copy[normalizeUiLanguage(locale)];
  const avatar = useCyreneAvatar();
  const timerId = useId();
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState(20);
  const [sound, setSound] = useState(false);
  const status = companion.session.status;
  const remaining = useRemainingTime(companion.session);
  const counting = status === "running" || status === "paused";

  return <>
    <button
      type="button"
      className={`cy-composer__agent-button cy-quiet-companion-trigger${counting ? " is-counting" : ""}`}
      aria-label={labels.title}
      aria-describedby={counting ? timerId : undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(true)}
    >
      {status === "running" ? <img src={avatar} alt="" /> :
        status === "paused" ? <Pause size={15} aria-hidden="true" /> : <Timer size={15} aria-hidden="true" />}
      <span>{labels.title}</span>
      {counting && <span id={timerId} className="cy-quiet-companion-trigger__time" role="timer">
        <span className="cy-quiet-companion-sr-only">{status === "paused" ? `${labels.paused} · ` : ""}{labels.remaining} </span>{remaining}
      </span>}
    </button>
    {status === "completed" && <span className="cy-quiet-companion-done" role="status">{labels.completed}</span>}
    <Modal
      open={open}
      title={labels.title}
      width={390}
      centered
      footer={null}
      destroyOnHidden
      onCancel={() => setOpen(false)}
    >
      <div className="cy-quiet-companion">
        {status === "idle" ? <>
          <fieldset className="cy-quiet-companion__duration">
            <legend>{labels.duration}</legend>
            <Radio.Group
              optionType="button"
              options={durations.map(value => ({ value, label: labels.minutes(value) }))}
              value={duration}
              onChange={event => setDuration(event.target.value)}
            />
          </fieldset>
          {typeof AudioContext !== "undefined" && <Checkbox checked={sound} onChange={event => setSound(event.target.checked)}>{labels.sound}</Checkbox>}
          <Button type="primary" onClick={() => { companion.start(duration, sound); setSound(false); setOpen(false); }}>{labels.start}</Button>
        </> : <>
          <div className="cy-quiet-companion__presence">
            <img src={avatar} alt="" />
            <span>{status === "running" ? labels.running : status === "paused" ? labels.paused : labels.completed}</span>
          </div>
          {counting && <div role="timer" aria-label={labels.remaining} className="cy-quiet-companion__time">{remaining}</div>}
          <div className="cy-quiet-companion__actions">
            {status === "completed" ? <>
              <Button type="primary" onClick={companion.end}>{labels.again}</Button>
              <Button type="text" onClick={() => { companion.end(); setOpen(false); }}>{labels.dismiss}</Button>
            </> : <>
              <Button onClick={status === "running" ? companion.pause : companion.resume}>{status === "running" ? labels.pause : labels.resume}</Button>
              <Button type="text" onClick={() => { companion.end(); setOpen(false); }}>{labels.end}</Button>
            </>}
          </div>
        </>}
      </div>
    </Modal>
  </>;
}
