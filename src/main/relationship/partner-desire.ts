import type { DesireSample, RelationshipState } from "../../shared/companion";

import { desireValue } from "../../shared/companion";

const HOUR = 3600000;
const STOP =
  /(?:不要|不想|别再?|停止|停下).{0,8}(?:调情|亲热|亲[我你亲]|吻[我你]|亲近|亲密|撩[我你]|继续)|今天不想|到此为止|不要了|别这样|先停一下/u;
const REST = /好累|很累|睡觉|想静静|先忙|难受|不舒服|着急/u;
const WARM =
  /(?:想|可以|来|让我|给我)(?:要)?(?:亲你|亲我|吻你|吻我|亲亲|和你亲热)|我也想亲|想跟你亲热/u;

export function desireSignal(text: string): DesireSample["reason"] | undefined {
  if (
    STOP.test(text) ||
    /^(?:不要|别|停|够了|先停停|stop|no thanks)[。.！!\s]*$/iu.test(text)
  )
    return "stop";
  if (REST.test(text)) return "rest";
  if (WARM.test(text)) return "warm";
  if (/想你了|想抱你|今晚陪我|喜欢你/u.test(text)) return "interest";
}
export function desireAvailable(rel: RelationshipState) {
  return (
    rel.recordHistory &&
    rel.relationshipMode === "partner" &&
    rel.desireEnabled &&
    rel.affection &&
    !rel.paused
  );
}
export function addDesireSample(
  history: DesireSample[],
  conversationId: string,
  turnId: string,
  text: string,
  now: number,
) {
  const reason = desireSignal(text);
  if (
    !reason ||
    history.some(
      (s) => s.conversationId === conversationId && s.turnId === turnId,
    )
  )
    return;
  const mine = history.filter((s) => s.conversationId === conversationId);
  const last = mine.at(-1);
  const previous = desireValue(last, now);
  const recent = mine.filter(
    (s) => now - s.at < 4 * HOUR && s.reason === reason,
  ).length;
  const value =
    reason === "stop"
      ? 0
      : reason === "rest"
        ? Math.max(0, previous - 16)
        : Math.min(
            100,
            previous +
              Math.max(
                2,
                Math.round((reason === "warm" ? 33 : 12) / (1 + recent)),
              ),
          );
  history.push({ conversationId, turnId, reason, value, at: now });
  if (history.length > 500) history.splice(0, history.length - 500);
}
export function desireContext(
  rel: RelationshipState,
  history: DesireSample[],
  id: string,
  text: string,
  now: number,
) {
  if (!desireAvailable(rel) || !text) return "";
  const mine = history.filter((s) => s.conversationId === id);
  const last = mine.at(-1);
  const signal = desireSignal(text);
  if (
    signal === "stop" ||
    signal === "rest" ||
    (mine.some((s) => s.reason === "stop" && now - s.at < 12 * HOUR) &&
      signal !== "warm")
  ) {
    return "对方希望休息或收住亲密话题。顺着眼下的话聊。";
  }
  if (signal === "warm")
    return "伴侣私聊。可以真诚表达自己的欲望，也可以依此刻的感受婉拒，听对方的回应。";
  if (rel.desireInitiative && desireValue(last, now) >= 40)
    return "伴侣私聊。你今天有些性致；如果眼下话题、对方的状态和边界合适，可以先调情一句，等对方回应。";
  return "";
}
