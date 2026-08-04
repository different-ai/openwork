import { describe, expect, test } from "bun:test";

import type { OpenworkSessionGroupEvent } from "../src/app/lib/openwork-server";
import { SessionGroupEventPoller } from "../src/react-app/shell/session-group-event-poller";

function event(seq: number, workspaceId = "workspace-a"): OpenworkSessionGroupEvent {
  return {
    id: `event-${seq}`,
    seq,
    workspaceId,
    type: "session_groups.updated",
    action: "updated",
    timestamp: seq,
  };
}

describe("session group event poller", () => {
  test("sends the newest returned sequence on the next poll", async () => {
    const poller = new SessionGroupEventPoller();
    const requests: number[] = [];
    const events = [event(1), event(2)];
    const request = async ({ since }: { since: number }) => {
      requests.push(since);
      return { items: events.filter((item) => item.seq > since), cursor: 0 };
    };

    await poller.poll("workspace-a", request, async () => {});
    await poller.poll("workspace-a", request, async () => {});

    expect(requests).toEqual([0, 2]);
  });

  test("keeps its cursor when a poll returns no events", async () => {
    const poller = new SessionGroupEventPoller();
    const requests: number[] = [];
    const request = async ({ since }: { since: number }) => {
      requests.push(since);
      return { items: since === 0 ? [event(3)] : [] };
    };

    await poller.poll("workspace-a", request, async () => {});
    await poller.poll("workspace-a", request, async () => {});
    await poller.poll("workspace-a", request, async () => {});

    expect(requests).toEqual([0, 3, 3]);
  });

  test("resets removed workspaces without leaking another workspace cursor", async () => {
    const poller = new SessionGroupEventPoller();
    const requests: Array<{ key: string; since: number }> = [];
    const poll = (key: string, seq: number) => poller.poll(
      key,
      async ({ since }) => {
        requests.push({ key, since });
        return { items: since === 0 ? [event(seq, key)] : [] };
      },
      async () => {},
    );

    poller.setWorkspaces(["workspace-a"]);
    await poll("workspace-a", 4);
    poller.setWorkspaces(["workspace-b"]);
    await poll("workspace-b", 7);
    poller.setWorkspaces(["workspace-a"]);
    await poll("workspace-a", 8);

    expect(requests).toEqual([
      { key: "workspace-a", since: 0 },
      { key: "workspace-b", since: 0 },
      { key: "workspace-a", since: 0 },
    ]);
  });

  test("applies each event once across the exclusive cursor boundary", async () => {
    const poller = new SessionGroupEventPoller();
    const events = [event(1), event(2)];
    const applied: string[] = [];
    const request = async ({ since }: { since: number }) => ({
      items: events.filter((item) => item.seq > since),
    });
    const apply = async (items: OpenworkSessionGroupEvent[]) => {
      applied.push(...items.map((item) => item.id));
    };

    await poller.poll("workspace-a", request, apply);
    events.push(event(3));
    await poller.poll("workspace-a", request, apply);

    expect(applied).toEqual(["event-1", "event-2", "event-3"]);
  });

  test("falls back to zero after an error or sequence gap", async () => {
    const poller = new SessionGroupEventPoller();
    const requests: number[] = [];
    let call = 0;
    const request = async ({ since }: { since: number }) => {
      requests.push(since);
      call += 1;
      if (call === 2) throw new Error("offline");
      if (call === 4) return { items: [event(3)] };
      if (call === 5) return { items: [event(1), event(3)] };
      return { items: since === 0 ? [event(1)] : [] };
    };

    await poller.poll("workspace-a", request, async () => {});
    await expect(poller.poll("workspace-a", request, async () => {})).resolves.toBeUndefined();
    await poller.poll("workspace-a", request, async () => {});
    await poller.poll("workspace-a", request, async () => {});
    await poller.poll("workspace-a", request, async () => {});

    expect(requests).toEqual([0, 1, 0, 1, 0]);
  });
});
