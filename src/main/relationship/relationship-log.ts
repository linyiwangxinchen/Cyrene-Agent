import { app } from "electron"
import path from "node:path"
import { RelationshipLogStore as CoreStore, type RelationshipTurnInput, type RelationshipLogEntry } from "./relationship-log-core"
export type { RelationshipChannel, RelationshipTurnInput, RelationshipLogEntry, RelationshipDailySummary, RelationshipPreferencesPatch } from "./relationship-log-core"

export class RelationshipLogStore extends CoreStore {
  constructor(filePath = path.join(app.getPath("userData"), "relationship-log.json")) { super(filePath) }
}

let defaultStore: RelationshipLogStore | null = null
let defaultPath = ""
export function getRelationshipStore(): RelationshipLogStore {
  const filePath = path.join(app.getPath("userData"), "relationship-log.json")
  if (!defaultStore || defaultPath !== filePath) { defaultPath = filePath; defaultStore = new RelationshipLogStore(filePath) }
  return defaultStore
}
export function recordRelationshipTurn(input: RelationshipTurnInput): Promise<RelationshipLogEntry | null> {
  return getRelationshipStore().recordTurn(input)
}
export function buildRelationshipContext(conversationId?: string, privateContext = true): Promise<string> {
  return getRelationshipStore().buildContext(conversationId, privateContext)
}
