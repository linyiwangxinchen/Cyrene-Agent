export type ResidentActivity = "work" | "study" | "meal" | "rest" | "sleep" | "travel" | "social" | "watch";
export type EventStatus = "planned" | "deferred" | "active" | "awaiting_resolution" | "completed" | "partial" | "failed" | "cancelled";
export interface CanonSource { id: string; title: string; url: string; kind: "official" | "transcript" | "community" }
export interface CanonMilestone { id: string; title: string; summary: string; sources: string[] }
export interface AmphoreusResident {
  id: string;
  name: string;
  kind: "golden_heir" | "npc" | "cyrene";
  identity: string;
  coreflame?: string;
  personality: string;
  home: string;
  activity: ResidentActivity;
  occupation: string;
  aspiration: string;
  relations: string;
  sources: string[];
  heirSeat?: string;
  voice?: string;
  values?: string[];
  preferences?: string[];
  dailyInterests?: string[];
  /** Continuation writing guidance; these are not new canon facts. */
  signatureDetails?: string[];
  relationshipHooks?: string[];
  avoidances?: string[];
}
export interface CanonFact { id: string; subject: string; statement: string; scope: "canon" | "continuation"; sources: string[]; revision: string }
export interface ResidentGoal { id: string; title: string; progress: number; status: "active" | "completed"; updatedAt: number; reason: string }
export interface ResidentMemory { id: string; eventId: string; at: number; kind: "experienced" | "heard" | "routine"; text: string; source: string; locationId: string }
export interface ResidentRelation { residentId: string; trust: number; reason: string; eventId?: string; updatedAt: number }
export interface ResidentState {
  id: string; energy: number; mood: string; attention: string; locationId: string;
  goals: ResidentGoal[]; memories: ResidentMemory[]; relations: ResidentRelation[]; heardEventIds: string[];
  lastMeaningfulAt: number; lastRoutineDate: string; updatedAt: number;
}
export interface PlaceState { id: string; access: "open" | "limited" | "closed"; condition: number; supplies: number; note: string; updatedAt: number; eventId?: string }
export interface WorldRoute { id: string; from: string; to: string; minutes: number }
export type EventCondition = { kind: "event"; eventId: string } | { kind: "place"; placeId: string; field: "condition" | "supplies"; minimum: number };
export type WorldEffect =
  | { kind: "place"; placeId: string; field: "condition" | "supplies"; delta: number; reason: string }
  | { kind: "access"; placeId: string; value: PlaceState["access"]; reason: string }
  | { kind: "goal"; residentId: string; goalId: string; delta: number; reason: string }
  | { kind: "relationship"; residentId: string; otherId: string; delta: number; reason: string };
export interface AmphoreusThread {
  id: string;
  title: string;
  summary: string;
  nextStep: string;
  participants: string[];
  status: "open" | "resolved";
  updatedAt: number;
  eventId?: string;
}
export interface AmphoreusEvent {
  id: string;
  date: string;
  startsAt: number;
  endsAt: number;
  locationId: string;
  participants: string[];
  activity: ResidentActivity;
  severity: "routine" | "notable" | "major";
  title: string;
  summary: string;
  outcome?: string;
  developments: Omit<AmphoreusThread, "updatedAt">[];
  status?: EventStatus;
  version?: number;
  intent?: string;
  conditions?: EventCondition[];
  effects?: WorldEffect[];
  visibility?: "public" | "participants";
  resolutionSource?: "model" | "engine" | "legacy";
  resolvedAt?: number;
  reason?: string;
  originalTimezone?: string;
  deferCount?: number;
}
export interface EventResolution { eventId: string; version: number; status: "completed" | "partial" | "failed"; outcome: string; effects: WorldEffect[]; developments: Omit<AmphoreusThread, "updatedAt">[] }
export interface AmphoreusDay {
  date: string;
  timezone: string;
  generatedAt: number;
  events: AmphoreusEvent[];
}
export type NarrativeStatus = "pending" | "generating" | "success" | "failed" | "unconfigured" | "cancelled";
export type NarrativeError = "invalid_output" | "request_failed" | "interrupted";
export interface NarrativeAttempt {
  date: string;
  timezone: string;
  count: number;
  status: NarrativeStatus;
  attemptedAt: number;
  retryAt: number;
  error?: NarrativeError;
  key?: string;
  purpose?: "plan" | "resolve";
  eventIds?: string[];
}
export interface WorldGap { id: string; from: number; to: number; summary: string; source: "offline" }
export interface WorldHistoryEntry { id: string; at: number; kind: "event" | "memory" | "thread" | "gap"; title: string; text: string; residentIds: string[]; locationId?: string; eventId?: string; status?: EventStatus; details?: Pick<AmphoreusEvent, "intent" | "conditions" | "effects" | "reason"> }
export interface WorldHistoryQuery { before?: number; beforeId?: string; since?: number; residentId?: string; locationId?: string; limit?: number }
export interface WorldHistoryPage { entries: WorldHistoryEntry[]; next?: { before: number; beforeId: string } }
export interface AmphoreusState {
  schema: 2;
  canonRevision: string;
  epoch: "post-irontomb-memory-continuation";
  createdAt: number;
  narrativeEnabled: boolean;
  days: AmphoreusDay[];
  attempts: NarrativeAttempt[];
  threads: AmphoreusThread[];
  appliedEventIds: string[];
  lastReconciledAt: number;
  residents: ResidentState[];
  places: PlaceState[];
  gaps: WorldGap[];
  lastLifeTick: number;
  timezone: string;
  revision: number;
  dailyModelBudget: number;
  eventFacts: Record<string, "completed" | "partial" | "failed" | "cancelled">;
}
export interface AmphoreusClock {
  date: string;
  time: string;
  timezone: string;
  minute: number;
  phase: "dawn" | "morning" | "noon" | "afternoon" | "dusk" | "night";
}
export interface ResidentNow {
  residentId: string;
  activity: ResidentActivity;
  title: string;
  locationId: string;
  startsAt: number;
  endsAt: number;
  source: "routine" | "llm";
  eventId: string;
}
export interface AmphoreusView {
  name: "翁法罗斯";
  canonRevision: string;
  premise: string;
  clock: AmphoreusClock;
  narrativeEnabled: boolean;
  narrative: NarrativeAttempt | null;
  lastSuccessfulDate: string | null;
  events: Array<Omit<AmphoreusEvent, "outcome" | "developments"> & { status: EventStatus; outcome?: string }>;
  threads: AmphoreusThread[];
  residents: AmphoreusResident[];
  activities: ResidentNow[];
  sources: CanonSource[];
  history: CanonMilestone[];
  facts: CanonFact[];
  residentStates: Array<Omit<ResidentState, "heardEventIds">>;
  places: PlaceState[];
  routes: WorldRoute[];
  gaps: WorldGap[];
  revision: number;
  budget: { limit: number; used: number };
}
