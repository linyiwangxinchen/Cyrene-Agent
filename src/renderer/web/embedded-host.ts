// Original auxiliary pages borrow the already authenticated parent bridge.
try {
  if (window.parent !== window && (window.parent as any).__cyreneWeb) {
    const parent = window.parent as any;
    const subscriptions = new Set<() => void>();
    for (const key of ["music", "musicPlayer", "tools", "settings", "cyrene", "stickerManager", "cyreneTheme", "call", "tts", "cyreneAvatar"]) {
      const source = parent[key];
      if (!source) continue;
      const listeners = new Map<PropertyKey, (...args: unknown[]) => unknown>();
      (window as any)[key] = new Proxy(source, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== "function" || typeof property !== "string" || !/^on[A-Z]/.test(property)) return value;
          if (!listeners.has(property)) listeners.set(property, (...args) => {
            const unsubscribe = Reflect.apply(value, target, args);
            if (typeof unsubscribe !== "function") return unsubscribe;
            const cleanup = () => {
              if (subscriptions.delete(cleanup)) unsubscribe();
            };
            subscriptions.add(cleanup);
            return cleanup;
          });
          return listeners.get(property);
        },
      });
    }
    // Unlike a desktop window, closing an iframe does not destroy its parent IPC bus.
    window.addEventListener("pagehide", () => {
      for (const cleanup of [...subscriptions]) cleanup();
    }, { once: true });
    (window as any).__cyreneWeb = true;
  }
} catch { /* Standalone desktop pages retain the native preload bridge. */ }
