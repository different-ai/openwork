import { test, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { OpenWorkV2 } from "../src/adapters/openwork-v2-01857.js";
import { Store } from "../src/storage/store.js";
import { Pairing } from "../src/auth/pairing.js";
import { createServers } from "../src/server.js";
test("approval replies enforce fresh revision, once/deny mapping, scope, and durable duplicate receipts", async () => {
  let pending = true;
  const writes: unknown[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      writes.push(JSON.parse(text));
      pending = false;
      res.writeHead(204);
      res.end();
      return;
    }
    res.end(
      JSON.stringify(
        req.url === "/health"
          ? { ok: true, version: "0.18.57" }
          : req.url?.endsWith("/permission")
            ? {
                data: pending
                  ? [
                      {
                        id: "per_test",
                        sessionID: "ses_test",
                        action: "external_directory",
                        resources: ["/synthetic/folder"],
                        save: ["/synthetic/folder"],
                      },
                    ]
                  : [],
              }
            : { data: { id: "ses_test", time: { created: 0 } } },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const parent = await mkdtemp(join(tmpdir(), "owr-approval-")),
    store = await Store.open(join(parent, "state")),
    token = "synthetic-device";
  await store.update((s) => {
    s.devices.push({
      id: "device",
      deviceId: "phone",
      name: "Phone",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      workspaceIds: ["ws_test"],
      active: true,
      revoked: false,
    });
  });
  const adapter = new OpenWorkV2(async () => ({
    origin: "http://127.0.0.1:" + (server.address() as any).port,
    token: "synthetic-upstream",
  }));
  await adapter.health();
  const apps = createServers({
      store,
      pairing: new Pairing(store),
      adapter,
      platform: "linux",
      architecture: "x64",
      origin: "https://host.test",
    }),
    headers = { authorization: "Bearer " + token },
    url = "/v1/workspaces/ws_test/sessions/ses_test/approvals/per_test/reply";
  try {
    expect(adapter.capabilities.replyApproval).toBe(true);
    const approval = (await adapter.readApprovals("ws_test", "ses_test"))[0]!;
    expect(approval.supportedDecisions).toEqual(["allowOnce", "deny"]);
    expect(
      (
        await apps.remote.inject({
          method: "POST",
          url,
          headers,
          payload: {
            requestId: randomUUID(),
            decision: "allowOnce",
            revision: "a".repeat(64),
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(writes).toEqual([]);
    expect(
      (
        await apps.remote.inject({
          method: "POST",
          url,
          headers,
          payload: {
            requestId: randomUUID(),
            decision: "always",
            revision: approval.revision,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await apps.remote.inject({
          method: "POST",
          url: url.replace("ws_test", "ws_private"),
          headers,
          payload: {
            requestId: randomUUID(),
            decision: "allowOnce",
            revision: approval.revision,
          },
        })
      ).statusCode,
    ).toBe(403);
    const payload = {
      requestId: randomUUID(),
      decision: "allowOnce",
      revision: approval.revision,
    };
    const first = await apps.remote.inject({
      method: "POST",
      url,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.state).toBe("accepted");
    const duplicate = await apps.remote.inject({
      method: "POST",
      url,
      headers,
      payload,
    });
    expect(duplicate.json()).toEqual(first.json());
    expect(writes).toEqual([{ reply: "once" }]);
    pending = true;
    expect(
      (
        await apps.remote.inject({
          method: "POST",
          url,
          headers,
          payload: { ...payload, requestId: randomUUID(), decision: "deny" },
        })
      ).json().data.state,
    ).toBe("accepted");
    expect(writes).toEqual([{ reply: "once" }, { reply: "reject" }]);
  } finally {
    await apps.remote.close();
    await apps.admin.close();
    await store.close();
    await rm(parent, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  }
});
