export type SocialAtomType = "long_term" | "short_term" | "open_loop";
export type SocialAtomStatus = "active" | "superseded" | "resolved";

export interface SocialTurnEvidence {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface SocialExtractionInput {
  conversationId: string;
  memoryScope?: string;
  source?: { userTurnId: string; assistantEntryId: string };
  userTurn: SocialTurnEvidence & { role: "user" };
  assistantTurn: SocialTurnEvidence & { role: "assistant" };
  retrievedAtoms: SocialAtom[];
  now: number;
  /** 用户时区；提取时把“明天”“周五”换成具体日期。 */
  timezone?: string;
}

export interface SocialAtom {
  id: string;
  conversationId: string;
  memoryScope?: string;
  type: SocialAtomType;
  content: string;
  evidenceTurnId: string;
  sourceEntryId?: string;
  /** 自动整理的转述尚未经用户核实，召回时使用可检查的原话。 */
  quoteOnly?: boolean;
  evidenceQuote: string;
  createdAt: number;
  expiresAt?: number;
  status: SocialAtomStatus;
  supersededByAtomId?: string;
  resolvedByTurnId?: string;
}

export type ValidatedSocialAtomOperation =
  | {
      operation: "add";
      atom: SocialAtom;
    }
  | {
      operation: "supersede";
      atom: SocialAtom;
      targetAtomId: string;
    }
  | {
      operation: "resolve";
      targetAtomId: string;
      evidenceTurnId: string;
      evidenceQuote: string;
    }
  /** 显式记忆工具：把一条标记为过时（不需要替代内容）。 */
  | {
      operation: "retire";
      targetAtomId: string;
    }
  /** 显式记忆工具：按用户要求彻底删除一条。 */
  | {
      operation: "delete";
      targetAtomId: string;
    };
