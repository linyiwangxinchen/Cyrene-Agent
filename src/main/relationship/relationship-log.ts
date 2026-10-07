import { app } from "electron"
import path from "node:path"
import { RelationshipLogStore as CoreStore, type RelationshipTurnInput, type RelationshipLogEntry } from "./relationship-log-core"
export type { RelationshipChannel, RelationshipTurnInput, RelationshipLogEntry, RelationshipDailySummary } from "./relationship-log-core"

export class RelationshipLogStore extends CoreStore {
  constructor(filePath = path.join(app.getPath("userData"), "relationship-log.json")) { super(filePath) }
}

let defaultStore: RelationshipLogStore | null = null
function getDefaultStore(): RelationshipLogStore {
  return defaultStore ??= new RelationshipLogStore()
}
export function recordRelationshipTurn(input: RelationshipTurnInput): Promise<RelationshipLogEntry | null> {
  return getDefaultStore().recordTurn(input)
}
export function buildRelationshipContext(): Promise<string> {
  return getDefaultStore().buildContext()
}
