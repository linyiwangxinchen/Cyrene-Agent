// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CURRENT_DISCLAIMER_VERSION } from "../../shared/disclaimer";
import type { WelcomeGateProps } from "../react/features/onboarding/WelcomeGate";
import { WebConsentGate } from "./WebConsentGate";

let gate: WelcomeGateProps;
vi.mock("../react/features/onboarding/WelcomeGate", () => ({
  WelcomeGate: (props: WelcomeGateProps) => { gate = props; return <div>{props.view}</div>; },
}));
vi.mock("../react/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let root: Root;
let get: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;
let decline: () => Promise<void>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  get = vi.fn().mockResolvedValue({ disclaimerAcceptedVersion: "2026-09-27" });
  save = vi.fn().mockResolvedValue({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION });
  decline = vi.fn(async () => {});
  window.settings = { getGeneral: get, saveGeneral: save } as unknown as typeof window.settings;
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; delete window.settings; });
async function render() { await act(async () => root.render(<WebConsentGate onDecline={decline}><p>workspace</p></WebConsentGate>)); }

it.each([undefined, "", "2026-09-27"])("requires explicit consent for old or missing version %s", async version => {
  get.mockResolvedValue({ disclaimerAcceptedVersion: version });
  await render();
  expect(gate.view).toBe("welcome");
  expect(document.body.textContent).not.toContain("workspace");
  await act(async () => gate.onViewDisclaimer());
  expect(gate.view).toBe("disclaimer");
  await act(async () => gate.onQuit());
  expect(decline).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});
it("opens the workspace only after the current version is saved once", async () => {
  let finish!: (value: unknown) => void;
  save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => gate.onViewDisclaimer());
  await act(async () => { gate.onAccept(); gate.onAccept(); gate.onQuit(); });
  expect(save).toHaveBeenCalledExactlyOnceWith({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION });
  expect(decline).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("workspace");
  await act(async () => finish({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION }));
  expect(document.body.textContent).toContain("workspace");
});
it("restores an already accepted session without writing settings", async () => {
  get.mockResolvedValue({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION });
  await render();
  expect(document.body.textContent).toContain("workspace");
  expect(save).not.toHaveBeenCalled();
});
it("keeps the disclaimer open on failed or unconfirmed writes and permits retry", async () => {
  save.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce({});
  await render(); await act(async () => gate.onViewDisclaimer());
  await act(async () => gate.onAccept());
  expect(gate.error).toBe("onboarding.saveFailed"); expect(gate.accepting).toBe(false);
  await act(async () => gate.onAccept());
  expect(gate.error).toBe("onboarding.saveFailed"); expect(document.body.textContent).not.toContain("workspace");
  await act(async () => gate.onAccept());
  expect(document.body.textContent).toContain("workspace");
});
it("fails closed on read errors, with retry and a sign-out path", async () => {
  get.mockRejectedValueOnce(new Error("offline"));
  await render();
  expect(document.body.textContent).toContain("onboarding.loadFailed");
  const retry = Array.from(document.querySelectorAll("button")).find(button => button.textContent === "common.retry")!;
  await act(async () => retry.click());
  expect(gate.view).toBe("welcome");
  expect(document.body.textContent).not.toContain("workspace");
});
