/** 跨桌面、Web、渠道与定时器的整轮互斥；与 CTA 的单次 append 锁相互独立。 */
type Release = () => void;
type Waiter = { grant: (release: Release) => void; signal?: AbortSignal; abort?: () => void };
type State = { waiting: Waiter[] };
const states = new Map<string, State>();

function aborted(): Error { return Object.assign(new Error("CONVERSATION_RUN_CANCELLED"), { name: "AbortError" }); }

function occupy(id: string, state: State): Release {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiting.shift();
    if (next) {
      if (next.abort) next.signal?.removeEventListener("abort", next.abort);
      next.grant(occupy(id, state));
    } else if (states.get(id) === state) states.delete(id);
  };
}

/** 前台保留原有 busy/takeover 语义，不把 IPC ack 挂在另一轮之后。 */
export function tryAcquireConversationRun(conversationId: string): Release | null {
  if (states.has(conversationId)) return null;
  const state: State = { waiting: [] };
  states.set(conversationId, state);
  return occupy(conversationId, state);
}

async function acquire(conversationId: string, signal?: AbortSignal): Promise<Release> {
  if (signal?.aborted) throw aborted();
  const release = tryAcquireConversationRun(conversationId);
  if (release) return release;
  const state = states.get(conversationId)!;
  return new Promise((grant, reject) => {
    const waiter: Waiter = { grant, signal };
    waiter.abort = () => {
      const index = state.waiting.indexOf(waiter);
      if (index >= 0) state.waiting.splice(index, 1);
      signal?.removeEventListener("abort", waiter.abort!);
      reject(aborted());
    };
    state.waiting.push(waiter);
    signal?.addEventListener("abort", waiter.abort, { once: true });
    if (signal?.aborted) waiter.abort();
  });
}

export async function withConversationRun<T>(conversationId: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await acquire(conversationId, signal);
  try {
    if (signal?.aborted) throw aborted();
    return await task();
  } finally { release(); }
}
