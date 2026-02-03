import type { ReloadEvent, ReloadReason, ReloadTrigger } from "./types.js";
import { shortId } from "./utils.js";

export class ReloadEventStore {
  private events: ReloadEvent[] = [];
  private seq = 0;
  private maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  record(workspaceId: string, reason: ReloadReason, trigger?: ReloadTrigger): ReloadEvent {
    const event: ReloadEvent = {
      id: shortId(),
      seq: ++this.seq,
      workspaceId,
      reason,
      trigger,
      timestamp: Date.now(),
    };

    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.splice(0, this.events.length - this.maxSize);
    }

    return event;
  }

  list(workspaceId: string, since?: number): ReloadEvent[] {
    const cursor = Number.isFinite(since) ? (since as number) : 0;
    return this.events.filter((event) => event.workspaceId === workspaceId && event.seq > cursor);
  }

  cursor(): number {
    return this.seq;
  }
}
