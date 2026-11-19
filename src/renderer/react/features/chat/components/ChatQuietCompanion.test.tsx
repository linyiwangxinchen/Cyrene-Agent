// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setUiLocale } from "../../../i18n";
import { ChatQuietCompanion, useQuietCompanion } from "./ChatQuietCompanion";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const now = new Date("2026-02-20T00:00:00Z");
let root: Root;
let controls: ReturnType<typeof useQuietCompanion>;

function Harness({ show = true }: { show?: boolean }) {
  controls = useQuietCompanion();
  return show ? <ChatQuietCompanion companion={controls} /> : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  setUiLocale("zh-CN");
  Object.assign(window, {
    matchMedia: vi.fn((media: string) => ({ media, matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })),
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function button(name: string) {
  const match = [...document.querySelectorAll("button")].find(item =>
    (item.getAttribute("aria-label") ?? item.textContent ?? "").replace(/\s/g, "") === name.replace(/\s/g, ""),
  );
  if (!match) throw new Error(`Button not rendered: ${name}`);
  return match;
}

async function click(name: string) {
  await act(async () => { button(name).click(); });
}

function remaining() {
  const trigger = button("安静共处");
  return trigger.querySelector(".cy-quiet-companion-trigger__time")?.textContent?.slice(-5);
}

it("reaches the deadline after hidden time and retains a paused timer when the controls unmount", async () => {
  await act(async () => root.render(<Harness />));
  await click("安静共处");
  await click("开始共处");
  expect(remaining()).toBe("20:00");
  await act(async () => { vi.advanceTimersByTime(2_000); });
  expect(remaining()).toBe("19:58");
  await click("安静共处");
  await click("暂停");
  expect(document.body.textContent).toContain("共处已暂停");
  await act(async () => root.render(<Harness show={false} />));
  await act(async () => { vi.advanceTimersByTime(5 * 60_000); });
  await act(async () => root.render(<Harness />));
  expect(remaining()).toBe("19:58");
  await click("安静共处");
  await click("继续");
  expect(controls.active).toBe(true);
  await act(async () => {
    vi.setSystemTime(new Date(now.getTime() + 40 * 60_000));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(controls.session.status).toBe("completed");
  expect(document.body.textContent).toContain("这段共处结束了");
  await click("关闭提示");
  expect(controls.active).toBe(false);
});

function useStubAudio() {
  const oscillatorStart = vi.fn();
  const finish = vi.fn();
  let oscillator: { onended: () => void } | undefined;
  class AudioStub {
    state: AudioContextState = "suspended";
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => { this.state = "running"; });
    close = vi.fn(async () => { this.state = "closed"; finish(); });
    static instances: AudioStub[] = [];
    constructor() { AudioStub.instances.push(this); }
    createOscillator() {
      return oscillator = {
        onended: () => {},
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: oscillatorStart,
        stop: vi.fn(),
      };
    }
    createGain() {
      return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
    }
  }
  vi.stubGlobal("AudioContext", AudioStub);
  return { instances: AudioStub.instances, oscillatorStart, finish, releaseSound: () => oscillator?.onended() };
}

it("opens sound only on opt-in start and plays a single chime after returning from a suspended tab", async () => {
  const audio = useStubAudio();
  await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
  await click("安静共处");
  await click("开始共处");
  expect(audio.instances).toHaveLength(0);
  await click("安静共处");
  await click("结束");

  await click("安静共处");
  const checkbox = document.querySelector<HTMLInputElement>(".cy-quiet-companion input[type='checkbox']")!;
  await act(async () => { checkbox.click(); });
  await click("开始共处");
  expect(audio.instances).toHaveLength(1);
  expect(audio.instances[0].resume).toHaveBeenCalledTimes(1);
  expect(audio.oscillatorStart).not.toHaveBeenCalled();
  await act(async () => {
    vi.setSystemTime(new Date(now.getTime() + 45 * 60_000));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(audio.oscillatorStart).toHaveBeenCalledTimes(1);
  audio.releaseSound();
  expect(audio.finish).toHaveBeenCalledTimes(1);
});

it("releases audio on a manual end and skips the completion chime", async () => {
  const audio = useStubAudio();
  await act(async () => root.render(<Harness show={false} />));
  await act(async () => { controls.start(10, true); });
  await act(async () => { controls.end(); });
  await act(async () => { vi.advanceTimersByTime(11 * 60_000); });
  expect(audio.finish).toHaveBeenCalledTimes(1);
  expect(audio.oscillatorStart).not.toHaveBeenCalled();
  expect(controls.session.status).toBe("idle");
});
