import type { OpenworkSessionGroupEvent } from "@/app/lib/openwork-server";

export type SessionGroupEventResponse = {
  items: OpenworkSessionGroupEvent[];
  gap?: boolean;
  reset?: boolean;
};

export class SessionGroupEventPoller {
  private cursorByWorkspace = new Map<string, number>();

  setWorkspaces(keys: string[]): void {
    const activeKeys = new Set(keys);
    for (const key of this.cursorByWorkspace.keys()) {
      if (!activeKeys.has(key)) this.cursorByWorkspace.delete(key);
    }
  }

  async poll(
    key: string,
    request: (options: { since: number }) => Promise<SessionGroupEventResponse>,
    apply: (items: OpenworkSessionGroupEvent[]) => Promise<void>,
  ): Promise<void> {
    const currentCursor = this.cursorByWorkspace.get(key) ?? 0;
    try {
      const response = await request({ since: currentCursor });
      if (response.gap || response.reset) {
        this.cursorByWorkspace.set(key, 0);
        return;
      }

      const items = response.items.filter((item) => Number.isFinite(item.seq) && item.seq > currentCursor);
      if (items.length === 0) return;

      const sequences = [...new Set(items.map((item) => item.seq))].sort((left, right) => left - right);
      if (currentCursor > 0 && sequences.some((sequence, index) => sequence !== currentCursor + index + 1)) {
        this.cursorByWorkspace.set(key, 0);
        return;
      }

      await apply(items);
      const latestSequence = sequences.at(-1);
      if (latestSequence !== undefined) this.cursorByWorkspace.set(key, latestSequence);
    } catch {
      this.cursorByWorkspace.set(key, 0);
    }
  }
}
