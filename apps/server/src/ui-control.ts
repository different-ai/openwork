import type { UiControlKind, UiControlRequest } from "./types.js";
import { shortId } from "./utils.js";

const WINDOW_CONNECTED_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const PENDING_WAIT_TIMEOUT_MS = 10_000;

interface PendingUiControlRequest {
  request: UiControlRequest;
  delivered: boolean;
  resolve: (result: unknown) => void;
  timeout: NodeJS.Timeout;
}

export class UiControlMailbox {
  private requests = new Map<string, PendingUiControlRequest>();
  private waiters = new Set<() => void>();
  private lastPollAt = 0;

  request(kind: UiControlKind, input?: unknown): Promise<unknown> {
    if (!this.connected()) {
      return Promise.resolve({
        ok: false,
        error: "No OpenWork window is connected to this server. Open the OpenWork app or its web tab and try again.",
      });
    }

    const id = shortId();
    const request: UiControlRequest = {
      id,
      kind,
      input,
      createdAt: Date.now(),
    };

    return new Promise<unknown>((resolve) => {
      const timeout = setTimeout(() => {
        this.requests.delete(id);
        resolve({ ok: false, error: "The OpenWork window did not answer within 5 seconds." });
      }, REQUEST_TIMEOUT_MS);

      this.requests.set(id, { request, delivered: false, resolve, timeout });
      const waiters = [...this.waiters];
      for (const wake of waiters) wake();
    });
  }

  async pending(options: { wait: boolean; signal: AbortSignal }): Promise<UiControlRequest[]> {
    if (options.signal.aborted) return [];
    this.lastPollAt = Date.now();
    const items = this.takeUndelivered();
    if (items.length > 0 || !options.wait) return items;

    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timeout);
        this.waiters.delete(wake);
        options.signal.removeEventListener("abort", wake);
        resolve();
      };
      const timeout = setTimeout(wake, PENDING_WAIT_TIMEOUT_MS);
      this.waiters.add(wake);
      options.signal.addEventListener("abort", wake, { once: true });
    });

    return options.signal.aborted ? [] : this.takeUndelivered();
  }

  reply(id: string, result: unknown): boolean {
    const pending = this.requests.get(id);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.requests.delete(id);
    pending.resolve(result);
    return true;
  }

  connected(): boolean {
    return Date.now() - this.lastPollAt <= WINDOW_CONNECTED_TIMEOUT_MS;
  }

  private takeUndelivered(): UiControlRequest[] {
    const items: UiControlRequest[] = [];
    for (const pending of this.requests.values()) {
      if (pending.delivered) continue;
      pending.delivered = true;
      items.push(pending.request);
    }
    return items;
  }
}
