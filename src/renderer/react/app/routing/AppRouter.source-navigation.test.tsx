// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AppRouter } from "./AppRouter";

const bridge = vi.hoisted(() => {
  const listeners = new Set<(id: string) => void>();
  return {
    listeners,
    visit: (id: string) => { for (const listener of listeners) listener(id); },
    mount: vi.fn(),
  };
});

vi.mock("../../features/chat/pages/ChatPage", () => ({
  ChatPage: ({ onOpenSettings }: { onOpenSettings: () => void }) => {
    const [id, setId] = useState("original");
    useEffect(() => {
      bridge.mount();
      bridge.listeners.add(setId);
      return () => { bridge.listeners.delete(setId); };
    }, []);
    return createElement("button", { onClick: onOpenSettings }, id);
  },
}));

vi.mock("../../features/settings/AppearanceSettingsPage", () => ({
  AppearanceSettingsPage: () => createElement("button", { onClick: () => bridge.visit("source") }, "Open source"),
}));

it("returns to the open Web chat without recreating the chat when opening a source", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, {
    __cyreneWeb: true,
    chatStore: {
      onReactSwitchSession(listener: (id: string) => void) {
        bridge.listeners.add(listener);
        return () => { bridge.listeners.delete(listener); };
      },
    },
  });
  try {
    await act(async () => root.render(createElement(AppRouter)));
    await vi.waitFor(() => expect(host.querySelector("button")?.textContent).toBe("original"));
    await act(async () => host.querySelector("button")!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Open source"));
    expect(host.querySelector(".cy-app-router__view.is-hidden")).not.toBeNull();
    const source = [...host.querySelectorAll("button")].find(button => button.textContent === "Open source");
    await act(async () => source!.click());
    expect(host.querySelector(".cy-app-router__view.is-hidden")).toBeNull();
    expect(host.querySelector("button")?.textContent).toBe("source");
    expect(bridge.mount).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Reflect.deleteProperty(window, "__cyreneWeb");
    Reflect.deleteProperty(window, "chatStore");
  }
});
