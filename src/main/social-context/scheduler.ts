import {
  parseAndValidateSocialExtraction,
  type SocialExtractionRepairContext,
} from "./extractor";
import type { SocialAtomStore } from "./store";
import type { SocialExtractionInput } from "./types";
import { getMemoryModeVersion, isPersonalMemoryEnabled } from "../memory/memory-mode";

const MAX_EXTRACTION_ATTEMPTS = 3;
const MAX_REPAIR_OUTPUT_CHARS = 6_000;

export interface SocialContextSchedulerDeps {
  store: SocialAtomStore;
  generate: (
    input: SocialExtractionInput,
    repair?: SocialExtractionRepairContext,
  ) => Promise<string>;
  enqueue: (label: string, task: () => Promise<void>) => Promise<unknown>;
  recordMetric?: (metric: {
    outcome: "success" | "failure";
    acceptedCount: number;
    rejectedCount: number;
    attempts: number;
    repairCount: number;
  }) => void;
  resolveSourceEntry?: (input: SocialExtractionInput) => Promise<string | undefined>;
  refreshAtoms?: (input: SocialExtractionInput) => Promise<SocialExtractionInput["retrievedAtoms"]>;
  isAllowedAtom?: (atom: SocialExtractionInput["retrievedAtoms"][number]) => Promise<boolean>;
  jobs?: {
    record(input: SocialExtractionInput): Promise<string | undefined>;
    pending(): Promise<Array<{ id: string; input: SocialExtractionInput }>>;
    complete(id: string): Promise<unknown>;
    discardPending(): Promise<void>;
  };
}

export function createSocialContextScheduler(deps: SocialContextSchedulerDeps): {
  schedule(input: SocialExtractionInput): void | Promise<void>;
  resumePending(): Promise<void>;
  discardPending(): Promise<void>;
} {
  const runningJobs = new Set<string>();
  const pendingWrites = new Set<Promise<void>>();
  async function discardPending(): Promise<void> {
    if (!deps.jobs) return;
    // Late writes handle their own epoch mismatch. Wait for their tombstones
    // as well as clearing any jobs left by older provider failures.
    await Promise.all([deps.jobs.discardPending(), ...pendingWrites]);
  }
  function enqueue(input: SocialExtractionInput, modeVersion: number, jobId?: string): void {
      if (jobId && runningJobs.has(jobId)) return;
      if (jobId) runningJobs.add(jobId);
      const isCurrent = () => isPersonalMemoryEnabled() && getMemoryModeVersion() === modeVersion;
      let attempts = 0;
      let repairCount = 0;
      void deps.enqueue("chat-social-context", async () => {
        if (deps.refreshAtoms && isCurrent()) input = { ...input, retrievedAtoms: await deps.refreshAtoms(input) };
        let repair: SocialExtractionRepairContext | undefined;
        for (let attempt = 0; attempt < MAX_EXTRACTION_ATTEMPTS; attempt += 1) {
          if (!isCurrent()) return;
          const sourceEntryId = await deps.resolveSourceEntry?.(input);
          if ((deps.resolveSourceEntry && !sourceEntryId) || !isCurrent()) return;
          attempts = attempt + 1;
          repairCount = attempt;
          const raw = await deps.generate(input, repair);
          if (!isCurrent()) return;
          const result = parseAndValidateSocialExtraction(raw, input);
          if (result.rejectedCount === 0) {
            if ((sourceEntryId && await deps.resolveSourceEntry?.(input) !== sourceEntryId) || !isCurrent()) return;
            let operations = result.operations.map(operation => "atom" in operation && sourceEntryId
              ? { ...operation, atom: { ...operation.atom, sourceEntryId, quoteOnly: true } } : operation);
            if (deps.isAllowedAtom) {
              const allowed = await Promise.all(operations.map(operation => "atom" in operation ? deps.isAllowedAtom!(operation.atom) : true));
              operations = operations.filter((_, index) => allowed[index]);
            }
            if (!isCurrent()) return;
            deps.store.applyOperations(input.conversationId, operations, input.now, input.memoryScope);
            deps.recordMetric?.({
              outcome: "success",
              acceptedCount: operations.length,
              rejectedCount: 0,
              attempts,
              repairCount,
            });
            return;
          }
          if (attempt === MAX_EXTRACTION_ATTEMPTS - 1) {
            deps.recordMetric?.({
              outcome: "failure",
              acceptedCount: 0,
              rejectedCount: result.rejectedCount,
              attempts: MAX_EXTRACTION_ATTEMPTS,
              repairCount: MAX_EXTRACTION_ATTEMPTS - 1,
            });
            return;
          }
          repair = {
            attempt: (attempt + 1) as 1 | 2,
            previousOutput: raw.slice(0, MAX_REPAIR_OUTPUT_CHARS),
            rejectedCount: result.rejectedCount,
          };
        }
      }).then(async () => {
        if (jobId) await deps.jobs?.complete(jobId);
      }).catch(() => {
        deps.recordMetric?.({
          outcome: "failure",
          acceptedCount: 0,
          rejectedCount: 0,
          attempts,
          repairCount,
        });
      }).finally(() => { if (jobId) runningJobs.delete(jobId); });
  }

  return {
    schedule(input) {
      if (!isPersonalMemoryEnabled()) return;
      const version = getMemoryModeVersion();
      if (!deps.jobs) return enqueue(input, version);
      const write = deps.jobs.record(input).then(async id => {
        if (!id) return;
        if (getMemoryModeVersion() === version) enqueue(input, version, id);
        else await deps.jobs?.complete(id);
      }).finally(() => pendingWrites.delete(write));
      pendingWrites.add(write);
      return write.catch(error => console.warn("[ChatSocialContext] failed to persist extraction job", error));
    },
    async resumePending() {
      if (!deps.jobs) return;
      if (!isPersonalMemoryEnabled()) return discardPending();
      const version = getMemoryModeVersion();
      for (const job of await deps.jobs.pending()) {
        if (getMemoryModeVersion() !== version) return;
        enqueue(job.input, version, job.id);
      }
    },
    discardPending,
  };
}
