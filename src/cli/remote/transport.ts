/**
 * A CoreTransport is the CLI's view of the shared business core: the same
 * invoke/event contract the browser uses through /api/core/invoke + /ws, or
 * the headless worker's IPC protocol when running with --local.
 */
export type CoreEventListener = (channel: string, args: unknown[]) => void;

export interface CoreTransport {
  /** Human readable target, e.g. "http://127.0.0.1:4317" or "local:/data". */
  readonly description: string;
  /** True when the core runs on another machine, so local paths are meaningless. */
  readonly remote: boolean;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  onEvent(listener: CoreEventListener): () => void;
  /** Called once if the connection drops unexpectedly. */
  onClose(listener: (reason: string) => void): () => void;
  close(): Promise<void>;
}

/** Login is missing, expired or was rejected. Maps to exit code 3. */
export class AuthError extends Error {}
/** The core or server could not be reached. Maps to exit code 3. */
export class ConnectionError extends Error {}
/** The core answered a request with an error code. */
export class CoreRequestError extends Error {
  constructor(public readonly code: string, public readonly status?: number) { super(code); }
}

export class Emitter<T extends unknown[]> {
  private listeners = new Set<(...args: T) => void>();
  add(listener: (...args: T) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(...args: T): void {
    for (const listener of [...this.listeners]) listener(...args);
  }
}
