import { ReplayBuffer, type BridgeEvent } from "./replay-buffer.js";
import { SSEParser } from "./sse.js";
import { normalizeEvent } from "./normalize.js";
import type { OpenWorkAdapter } from "../adapters/types.js";
export class EventHub {
  readonly buffer = new ReplayBuffer();
  private controller = new AbortController();
  private listeners = new Set<(event: BridgeEvent) => void>();
  private tasks: Promise<void>[] = [];
  private tracked = new Set<string>();
  private discoveryTimer?: NodeJS.Timeout;
  constructor(private adapter: OpenWorkAdapter) {}
  add(listener: (event: BridgeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: BridgeEvent) {
    for (const listener of this.listeners) listener(event);
  }
  async start() {
    await this.refreshWorkspaces();
    this.discoveryTimer = setInterval(() => {
      void this.refreshWorkspaces().catch(() => {});
    }, 15000);
    this.discoveryTimer.unref();
  }
  async refreshWorkspaces() {
    const workspaces = await this.adapter.listWorkspaces();
    if (this.controller.signal.aborted) return;
    for (const w of workspaces)
      if (!this.tracked.has(w.id)) {
        this.tracked.add(w.id);
        this.tasks.push(this.run(w.id));
      }
  }
  private async run(wid: string) {
    let failures = 0;
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        await this.adapter.health();
        const r = await this.adapter.subscribe(wid, signal);
        this.emit(
          this.buffer.append(
            { kind: "hostChanged", workspaceId: wid },
            "reset",
          ),
        );
        failures = 0;
        const parser = new SSEParser(),
          reader = r.body!.getReader();
        try {
          for (;;) {
            const x = await reader.read();
            if (x.done) break;
            for (const f of parser.push(x.value)) {
              let value: unknown;
              try {
                value = JSON.parse(f.data);
              } catch {
                value = null;
              }
              const n = normalizeEvent(value, wid);
              this.emit(
                this.buffer.append(n.hint, n.reset ? "reset" : "change"),
              );
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch {
        if (!signal.aborted)
          this.emit(
            this.buffer.append(
              { kind: "hostChanged", workspaceId: wid },
              "reset",
            ),
          );
      }
      if (!signal.aborted) {
        const ms = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
        await new Promise<void>((resolve) => {
          const done = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            },
            timer = setTimeout(done, ms);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    }
  }
  async close() {
    clearInterval(this.discoveryTimer);
    this.controller.abort();
    await Promise.allSettled(this.tasks);
    this.listeners.clear();
  }
}
