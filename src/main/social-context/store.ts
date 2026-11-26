import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import type { SocialAtom, ValidatedSocialAtomOperation } from "./types";

interface SocialAtomFile {
  schemaVersion: 1;
  atoms: SocialAtom[];
  forgotten?: string[];
}

export interface SocialAtomStore {
  listActive(conversationId: string, now?: number, memoryScope?: string): SocialAtom[];
  getById(id: string): SocialAtom | undefined;
  applyOperations(
    conversationId: string,
    operations: readonly ValidatedSocialAtomOperation[],
    now?: number,
    memoryScope?: string,
  ): void;
  replaceForTest(atoms: SocialAtom[]): void;
}

function isActive(atom: SocialAtom, now: number): boolean {
  return atom.status === "active"
    && (typeof atom.expiresAt !== "number" || atom.expiresAt > now);
}

export function createSocialAtomStore(filePath?: string): SocialAtomStore {
  let loaded = false;
  let atoms: SocialAtom[] = [];
  let forgotten = new Set<string>();
  const fingerprint = (atom: SocialAtom) => createHash("sha256").update(JSON.stringify([
    atom.memoryScope, atom.conversationId, atom.sourceEntryId ?? atom.evidenceTurnId, atom.type, atom.content.trim(),
  ])).digest("hex");

  const load = (): void => {
    if (loaded) return;
    loaded = true;
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SocialAtomFile>;
      atoms = Array.isArray(parsed.atoms) ? parsed.atoms : [];
      forgotten = new Set(Array.isArray(parsed.forgotten) ? parsed.forgotten.filter(key => typeof key === "string") : []);
    } catch {
      atoms = [];
    }
  };

  const save = (next: SocialAtom[], denied: Set<string>): void => {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify({ schemaVersion: 1, atoms: next, forgotten: [...denied] } satisfies SocialAtomFile, null, 2),
      "utf8",
    );
    fs.renameSync(temporaryPath, filePath);
  };

  return {
    listActive(conversationId, now = Date.now(), memoryScope) {
      load();
      return atoms.filter((atom) => atom.conversationId === conversationId && atom.memoryScope === memoryScope && isActive(atom, now));
    },

    getById(id) {
      load();
      return atoms.find((atom) => atom.id === id);
    },

    applyOperations(conversationId, operations, now = Date.now(), memoryScope) {
      load();
      if (operations.length === 0) return;
      let next = atoms.map(atom => ({ ...atom }));
      const denied = new Set(forgotten);
      const inScope = (atom: SocialAtom) => atom.conversationId === conversationId && atom.memoryScope === memoryScope;
      for (const operation of operations) {
        if (operation.operation === "delete") {
          const target = next.find(atom => atom.id === operation.targetAtomId && inScope(atom));
          if (target) denied.add(fingerprint(target));
          next = next.filter((atom) => !(
            atom.id === operation.targetAtomId && inScope(atom)
          ));
          continue;
        }
        if (operation.operation === "retire") {
          const target = next.find((atom) => (
            atom.id === operation.targetAtomId
            && inScope(atom)
            && isActive(atom, now)
          ));
          if (target) target.status = "superseded";
          continue;
        }
        if (operation.operation === "resolve") {
          const target = next.find((atom) => (
            atom.id === operation.targetAtomId
            && inScope(atom)
            && atom.type === "open_loop"
            && isActive(atom, now)
          ));
          if (!target) continue;
          target.status = "resolved";
          target.resolvedByTurnId = operation.evidenceTurnId;
          continue;
        }

        if (!inScope(operation.atom) || denied.has(fingerprint(operation.atom))) continue;
        const duplicate = next.some((atom) => (
          inScope(atom)
          && atom.type === operation.atom.type
          && atom.evidenceTurnId === operation.atom.evidenceTurnId
          && atom.content.trim() === operation.atom.content.trim()
        ));
        if (duplicate) continue;
        if (operation.operation === "supersede") {
          const target = next.find((atom) => (
            atom.id === operation.targetAtomId
            && inScope(atom)
            && isActive(atom, now)
          ));
          if (!target) continue;
          target.status = "superseded";
          target.supersededByAtomId = operation.atom.id;
        }
        if (!next.some((atom) => atom.id === operation.atom.id)) {
          next.push(operation.atom);
        }
      }
      save(next, denied);
      atoms = next;
      forgotten = denied;
    },

    replaceForTest(next) {
      loaded = true;
      atoms = [...next];
      forgotten = new Set();
    },
  };
}
