import { AMPHOREUS_FACTS } from "../../shared/amphoreus-canon";
export class InvalidNarrative extends Error { constructor() { super("invalid_output"); } }
export class FutureWorldVersion extends Error { constructor() { super("Unsupported Amphoreus world version; existing file preserved"); } }
export function check(condition: unknown): asserts condition { if (!condition) throw new InvalidNarrative(); }
export function record(value: unknown): Record<string, unknown> { check(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
export function boundedText(value: unknown, max: number): string { check(typeof value === "string" && value.trim().length > 0 && value.length <= max); return value.trim(); }
export function finite(value: unknown): number { check(typeof value === "number" && Number.isFinite(value)); return value; }
export function list(value: unknown, min: number, max: number): unknown[] { check(Array.isArray(value) && value.length >= min && value.length <= max); return value; }
export function jsonObject(output: string): Record<string, unknown> {
  check(output.length <= 64_000);
  try { return record(JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))); } catch { throw new InvalidNarrative(); }
}
export function onlyKeys(raw: Record<string, unknown>, keys: readonly string[]) { check(Object.keys(raw).every((key) => keys.includes(key))); }
/** Known explicit conflicts are rejected; structured effects provide the hard state boundary. */
export function assertCanonText(value: string): void {
  for (const sentence of value.split(/[。！？\n；;，,]|但是|然而|不过/u)) {
    if (/(不得|不能|不会|并未|没有|禁止|不应|拒绝).{0,12}(转让|改写|复活|复苏|重置|黄金裔)/u.test(sentence)) continue;
    check(!/(火种.{0,16}(转让|转交|易主|换给)|第十三[位个名]黄金裔|(?:复活|复苏|再造).{0,8}铁墓|铁墓.{0,8}(?:复活|复苏|重生)|(?:重置|重启).{0,8}(?:世界|轮回)|(?:cyrene|昔涟).{0,12}真我火种)/iu.test(sentence));
    check(!/(?:transfer|give|hand).{0,35}coreflame|thirteenth chrysos|(?:revive|resurrect).{0,20}irontomb/iu.test(sentence));
  }
}
export function storyText(value: unknown, max: number): string { const text = boundedText(value, max); assertCanonText(text); return text; }
export function reviewAccepted(output: string): boolean {
  const raw = jsonObject(output);
  return raw.consistent === true && Array.isArray(raw.factIds) && new Set(raw.factIds).size >= 2 && raw.factIds.every((id) => AMPHOREUS_FACTS.some((fact) => fact.id === id));
}
