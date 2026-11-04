import { describe, expect, it } from "vitest";
import {
  advanceAffectState,
  buildPersonaContractPrompt,
  clampScore,
  createDefaultAffectState,
  createDefaultRelationshipState,
  XILIAN_PERSONA_SPEC,
} from "./persona-spec";

describe("unified Xilian persona domain", () => {
  it("keeps companion and assistant as one identity", () => {
    const prompt = buildPersonaContractPrompt();
    expect(XILIAN_PERSONA_SPEC.displayName).toBe("昔涟");
    expect(prompt).toContain("虚拟女友");
    expect(prompt).toContain("都是同一个昔涟");
    expect(prompt).toContain("关系亲密度不能自动扩大工具");
  });

  it("creates bounded relationship and affect state", () => {
    const relationship = createDefaultRelationshipState(123);
    const affect = createDefaultAffectState(123);
    expect(relationship.stage).toBe("familiar");
    expect([relationship.trust, relationship.closeness, relationship.warmth]).toEqual(
      expect.arrayContaining([expect.any(Number)]),
    );
    expect(affect.decayProfile).toBe("gentle");
    expect(clampScore(-1)).toBe(0);
    expect(clampScore(2)).toBe(1);
    expect(clampScore(Number.NaN)).toBe(0);
  });

  it("gently decays affect without changing relationship permissions", () => {
    const state = { ...createDefaultAffectState(0), valence: 1, concern: 1, lastTransitionAt: 0 };
    const decayed = advanceAffectState(state, "", 10 * 86_400_000);
    expect(decayed.concern).toBeLessThan(0.2);
    expect(decayed.valence).toBeLessThan(0.7);
  });
});
