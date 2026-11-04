import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { z } from "zod";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import { createDriveUploadPreflight } from "../src/extensions/approved-drive-upload.js";
import { callOpenWorkCloudUploadAction } from "../src/extensions/cloud-uploads.js";
import type { ServerConfig } from "../src/types.js";

const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
const pendingSchema = z.object({ data: z.array(z.object({ id: z.string(), resources: z.array(z.string()), save: z.array(z.string()).optional() })) });

test("the real native engine remembers a Drive file scope only after Allow for session", { timeout: 90_000 }, async t => {
  try { await access(binary); } catch { t.skip("needs: pinned OpenCode V2 binary; set OPENWORK_TEST_OPENCODE2"); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), "drive-session-native-")));
  const directory = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(directory); await mkdir(home);
  const path = join(root, "outside-report.pdf");
  const bytes = Buffer.from("synthetic exact-file upload witness");
  await writeFile(path, bytes);
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [directory], readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  let sent = 0;
  const prepare = createDriveUploadPreflight(config, async (_path, request, file) => {
    const context = z.object({ context: z.record(z.string(), z.unknown()) }).parse(JSON.parse(String(request.body))).context;
    return callOpenWorkCloudUploadAction(config, "drive_upload_file", file.args, context, {
      approvedDriveFile: file, signal: request.signal ?? undefined,
      readCloudMcp: async () => ({ type: "remote", url: "https://cloud.test/mcp/agent", enabled: true, oauth: false, headers: { Authorization: "Bearer synthetic" } }),
      fetchImpl: async (_url, init) => {
        assert.ok(init?.body instanceof FormData);
        const upload = init.body.get("file"); assert.ok(upload instanceof File);
        assert.deepEqual(Buffer.from(await upload.arrayBuffer()), bytes);
        sent++;
        return Response.json({ ok: true, file: { id: `uploaded-${sent}` } });
      },
    });
  });
  const bridge = await createV2ContextBridge(async () => { throw new Error("must use the exact-file capability"); }, () => engine, prepare);
  try {
    engine = await createManagedOpencodeV2Server({ bin: binary, rootDir: join(root, "engine"), contextTools: bridge,
      env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "true" },
    });
    const created = await engine.fetchJson("/api/session", { method: "POST", body: { title: "Drive session approval witness", location: { directory }, permissions: [{ action: "drive_upload_file", resource: "*", effect: "ask" }] } });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const sessionId = z.object({ data: z.object({ id: z.string() }) }).parse(created.json).data.id;
    const permissions = async () => {
      assert.ok(engine);
      const result = await engine.fetchJson(`/api/session/${sessionId}/permission`, { directory });
      assert.equal(result.status, 200, JSON.stringify(result.json));
      return pendingSchema.parse(result.json).data;
    };
    const upload = (folderId = "selected-folder", targetSessionId = sessionId, connectionId: string | null = "google-workspace") => fetch(bridge.url, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ name: "openwork_drive_upload", input: { path, folderId, connectionId: connectionId ?? undefined }, sessionId: targetSessionId, caller: { directory, messageId: "msg_upload", callId: "call_upload" } }),
    });
    const waitForPermission = async (uploading: Promise<Response>) => {
      let early: Response | undefined;
      void uploading.then(response => { early = response; }).catch(() => undefined);
      for (let count = 0; count < 100; count++) {
        if (early) throw new Error(`upload settled before approval: HTTP ${early.status} ${await early.clone().text()}`);
        const pending = await permissions();
        if (pending[0]) return pending[0];
        await delay(50);
      }
      throw new Error("native upload approval did not appear");
    };
    const first = upload();
    void first.catch(() => undefined);
    const prompt = await waitForPermission(first);
    assert.deepEqual(prompt.save, prompt.resources);
    assert.equal(sent, 0, "no file bytes before approval");
    const allowed = await engine.fetchJson(`/api/session/${sessionId}/permission/${prompt.id}/reply`, { directory, method: "POST", body: { decision: "always" } });
    assert.equal(allowed.status, 204, JSON.stringify(allowed.json));
    const firstResult = await first;
    assert.equal(firstResult.status, 200, await firstResult.text());
    const repeated = await upload();
    assert.equal(repeated.status, 200, await repeated.text());
    assert.equal(sent, 2, "the exact file is uploaded again without another prompt");
    assert.deepEqual(await permissions(), []);
    const otherFolder = upload("different-folder");
    void otherFolder.catch(() => undefined);
    const secondPrompt = await waitForPermission(otherFolder);
    assert.notDeepEqual(secondPrompt.resources, prompt.resources);
    await engine.fetchJson(`/api/session/${sessionId}/permission/${secondPrompt.id}/reply`, { directory, method: "POST", body: { decision: "reject" } });
    const declined = await otherFolder;
    assert.equal(declined.status, 400, await declined.text());
    assert.equal(sent, 2, "a declined destination never receives bytes");

    const restricted = await engine.fetchJson("/api/session", { method: "POST", body: {
      title: "Path-restricted upload witness", location: { directory }, permissions: [
        { action: "drive_upload_file", resource: "*", effect: "ask" },
        { action: "drive_upload_file", resource: path, effect: "deny" },
      ],
    } });
    const restrictedId = z.object({ data: z.object({ id: z.string() }) }).parse(restricted.json).data.id;
    const blocked = await upload("selected-folder", restrictedId);
    assert.equal(blocked.status, 400, await blocked.clone().text());
    assert.match(await blocked.text(), /permissions do not allow/);
    assert.equal(sent, 2, "actual file-path deny cannot be bypassed by the saved-scope digest");

    for (const decision of ["always", "reject"]) {
      const implicit = upload("selected-folder", sessionId, null);
      void implicit.catch(() => undefined);
      const implicitPrompt = await waitForPermission(implicit);
      assert.deepEqual(implicitPrompt.save, [], "unresolved default account cannot be remembered");
      await engine.fetchJson(`/api/session/${sessionId}/permission/${implicitPrompt.id}/reply`, { directory, method: "POST", body: { decision } });
      const result = await implicit;
      assert.equal(result.status, decision === "always" ? 200 : 400, await result.text());
    }
    assert.equal(sent, 3, "default selection needs fresh consent even after a session grant for an explicit account");
  } finally {
    await bridge.close(); await engine?.close();
    await rm(root, { recursive: true, force: true });
  }
});
