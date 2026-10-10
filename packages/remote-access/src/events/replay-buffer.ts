import { randomUUID } from "node:crypto";
export interface Hint {
  kind:
    | "sessionChanged"
    | "messageChanged"
    | "statusChanged"
    | "approvalsChanged"
    | "hostChanged";
  workspaceId?: string;
  sessionId?: string;
  entityId?: string;
}
export interface BridgeEvent {
  id: string;
  event: "change" | "reset";
  data: Hint;
}
export class ReplayBuffer {
  private events: { event: BridgeEvent; bytes: number }[] = [];
  private bytes = 0;
  private seq = 0;
  constructor(
    private maxCount = 1000,
    private maxBytes = 16 * 1024 * 1024,
    private epoch: string = randomUUID(),
  ) {}
  append(data: Hint, event: "change" | "reset" = "change") {
    const e: BridgeEvent = { id: this.epoch + ":" + ++this.seq, event, data };
    const bytes = Buffer.byteLength(JSON.stringify(e));
    this.events.push({ event: e, bytes });
    this.bytes += bytes;
    while (this.events.length > this.maxCount || this.bytes > this.maxBytes) {
      this.bytes -= this.events.shift()!.bytes;
    }
    return e;
  }
  replay(
    cursor: string | undefined,
    workspaces: string[],
    allWorkspaces = false,
  ) {
    if (!cursor) return { reset: true, events: [] };
    const prefix = this.epoch + ":",
      n = Number(cursor.slice(prefix.length)),
      first = this.events[0]?.event.id;
    const floor = first ? Number(first.slice(prefix.length)) - 1 : this.seq;
    if (
      !cursor.startsWith(prefix) ||
      !Number.isSafeInteger(n) ||
      n < floor ||
      n > this.seq
    )
      return { reset: true, events: [] };
    return {
      reset: false,
      events: this.events
        .filter(
          (e) =>
            Number(e.event.id.slice(prefix.length)) > n &&
            (!e.event.data.workspaceId ||
              allWorkspaces ||
              workspaces.includes(e.event.data.workspaceId)),
        )
        .map((e) => e.event),
    };
  }
}
