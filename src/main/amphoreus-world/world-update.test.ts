import { expect, it } from "vitest";
import { worldUpdate } from "./world-update";
import { amphoreusView, createAmphoreusState } from "./engine";
import { createDefaultXilianWorldData, type XilianWorldView } from "../../shared/xilian-world";
import { AMPHOREUS_LOCATIONS } from "../../shared/amphoreus-canon";
it("sends only the clock when unchanged, but detects resident activity and artifact changes", () => {
  const now = Date.parse("2026-11-10T08:00:00Z");
  const view: XilianWorldView = { ...createDefaultXilianWorldData("2026-11-10", now), locations: AMPHOREUS_LOCATIONS, amphoreus: amphoreusView(createAmphoreusState(now), now, "UTC") };
  const first = worldUpdate(view);
  expect(first.view).toBe(view);
  view.amphoreus!.clock.time = "08:01";
  const next = worldUpdate(view, first.cursor);
  expect(next.view).toBeUndefined(); expect(next.clock!.time).toBe("08:01");
  expect(JSON.stringify(next).length).toBeLessThan(500);
  view.amphoreus!.activities[1].title = "临时调整了安排";
  expect(worldUpdate(view, first.cursor).view).toBe(view);
  expect(() => worldUpdate(view, { invalid: true })).toThrow();
});
