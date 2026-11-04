/** Coalesce public readiness probes; a failed/timed-out core must never look healthy. */
export function createReadinessProbe(check: () => Promise<boolean>, now = Date.now) {
  let pending: Promise<boolean> | undefined;
  let lastAt = -Infinity;
  let last = false;
  return () => {
    if (pending) return pending;
    if (now() - lastAt < 1_000) return Promise.resolve(last);
    pending = Promise.resolve().then(check).catch(() => false).then(value => {
      last = value === true;
      lastAt = now();
      return last;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
