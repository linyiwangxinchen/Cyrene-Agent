import { createHash } from "node:crypto";
import type { XilianWorldView } from "../../shared/xilian-world";

/** Include activities and artifacts as well as persisted revisions; their clocks differ. */
export function worldUpdate(view: XilianWorldView, previous?: unknown) {
  if (previous != null && (typeof previous !== "string" || previous.length > 64)) throw new Error("Invalid world cursor");
  const { clock, ...world } = view.amphoreus ?? {};
  const cursor = createHash("sha256").update(JSON.stringify({ ...view, amphoreus: world })).digest("hex");
  return { cursor, clock, ...(cursor === previous ? {} : { view }) };
}
