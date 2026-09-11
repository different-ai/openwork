import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { faultProxy, test } from "@openwork/testkit";

const config = {
  repository: "different-ai/openwork",
  tag: "v0.18.38",
  githubToken: "synthetic-github-only",
  slackToken: "synthetic-slack-only",
  channel: "C012RELEASE",
};
const { notifyRelease }: {
  notifyRelease: (input: Partial<typeof config> & { request: typeof fetch }) => Promise<unknown>;
} = await import(new URL("../../scripts/release/notify-slack.mjs", import.meta.url).href);

const pending = "<!-- openwork-slack-release:pending -->";
const sent = "<!-- openwork-slack-release:sent -->";
const lookupPath = `/repos/${config.repository}/releases/tags/${config.tag}`;
const patchPath = `/repos/${config.repository}/releases/42`;
const slackPath = "/api/chat.postMessage";
const stable = {
  id: 42,
  tag_name: config.tag,
  draft: false,
  prerelease: false,
  published_at: "2026-09-10T10:00:00Z",
  name: "UNTRUSTED TITLE <!channel> @everyone",
  body: "UNTRUSTED BODY <!here> <@U123> @channel https://untrusted.invalid/notes",
  html_url: "https://untrusted.invalid/release",
};

test("stable release notifications are credential-isolated, safe and at-most-once across provider failures", { timeout: 90_000 }, async ({ evidence }) => {
  let release: Record<string, unknown> = { ...stable };
  let slackReply: unknown = { ok: true, channel: config.channel, ts: "123.456" };
  let slackMode = "json";
  let unconfirmedPatch = false;
  let failFinalPatch = false;
  let patches = 0;
  const requests: { method: string; path: string; headers: IncomingHttpHeaders; body: unknown }[] = [];
  const witnessErrors: unknown[] = [];
  const witness = createServer((incoming, response) => {
    void (async () => {
      const raw = await text(incoming);
      const body: unknown = raw ? JSON.parse(raw) : null;
      assert(incoming.method && incoming.url);
      requests.push({ method: incoming.method, path: incoming.url, headers: incoming.headers, body });
      response.setHeader("content-type", "application/json");
      if (incoming.method === "GET" && incoming.url === lookupPath) {
        response.end(JSON.stringify(release));
      } else if (incoming.method === "PATCH" && incoming.url === patchPath) {
        patches += 1;
        assert(typeof body === "object" && body !== null && "body" in body && typeof body.body === "string");
        if (failFinalPatch && patches === 2) {
          response.writeHead(503);
          response.end(JSON.stringify({ error: `${config.githubToken} must not escape` }));
          return;
        }
        if (!unconfirmedPatch) release.body = body.body;
        response.end(JSON.stringify(release));
      } else if (incoming.method === "POST" && incoming.url === slackPath) {
        if (slackMode === "timeout") {
          // Slack has received the POST, but its response never completes. Use
          // the notifier's real AbortSignal timeout, not a synthetic rejection.
          response.writeHead(200);
          response.write('{"ok":');
        } else {
          response.end(slackMode === "malformed" ? "not json" : JSON.stringify(slackReply));
        }
      } else {
        throw new Error(`Unexpected witness route: ${incoming.method} ${incoming.url}`);
      }
    })().catch((error: unknown) => {
      witnessErrors.push(error);
      response.writeHead(500);
      response.end("witness failed");
    });
  });
  await new Promise<void>((resolve, reject) => {
    witness.once("error", reject);
    witness.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = witness.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    await using proxy = await faultProxy({ apiUrl: origin, webUrl: origin });
    const routes = new Map([
      [`https://api.github.com${lookupPath}`, lookupPath],
      [`https://api.github.com${patchPath}`, patchPath],
      [`https://slack.com${slackPath}`, slackPath],
    ]);
    const requestedUrls: string[] = [];
    const slackSignals: AbortSignal[] = [];
    const request: typeof fetch = async (url, options) => {
      assert(typeof url === "string");
      requestedUrls.push(url);
      const path = routes.get(url);
      assert(path, `Provider URL is not allowlisted: ${url}`);
      assert.equal(options?.redirect, "error");
      assert(options?.signal instanceof AbortSignal);
      if (path === slackPath) slackSignals.push(options.signal);
      // Rewrite only the three exact provider URLs; preserve payload, headers,
      // redirect policy and timeout signal through real HTTP and faultProxy.
      return fetch(`${proxy.ref.webUrl}${path}`, options);
    };
    const run = (overrides: Partial<typeof config> = {}) => notifyRelease({ ...config, ...overrides, request });
    let logStart = 0;
    const trace = async () => (await proxy.requestLog()).slice(logStart).map(({ method, path }) => `${method} ${path}`);
    const get = `GET ${lookupPath}`;
    const patch = `PATCH ${patchPath}`;
    const post = `POST ${slackPath}`;
    const reset = async (overrides: Record<string, unknown> = {}) => {
      release = { ...stable, ...overrides };
      requests.length = 0;
      requestedUrls.length = 0;
      slackReply = { ok: true, channel: config.channel, ts: "123.456" };
      slackMode = "json";
      slackSignals.length = 0;
      unconfirmedPatch = false;
      failFinalPatch = false;
      patches = 0;
      logStart = (await proxy.requestLog()).length;
      await proxy.faults.clear();
    };
    const proved = async (claim: string) => {
      assert.deepEqual(witnessErrors, []);
      for (const observed of requests) {
        const slack = observed.path === slackPath;
        assert.equal(observed.headers.authorization, `Bearer ${slack ? config.slackToken : config.githubToken}`);
        assert(!JSON.stringify(observed).includes(slack ? config.githubToken : config.slackToken));
      }
      evidence.recordAssertionEvidence(claim, JSON.stringify({ requests: await trace(), body: release.body }), true);
    };

    assert.deepEqual(await run(), { status: "sent" });
    assert.deepEqual(await trace(), [get, patch, post, patch]);
    assert.deepEqual(requests.filter((entry) => entry.method === "PATCH").map((entry) => entry.body), [
      { body: `${stable.body}\n\n${pending}` },
      { body: `${stable.body}\n\n${sent}` },
    ]);
    assert.deepEqual(requests.find((entry) => entry.path === slackPath)?.body, {
      channel: config.channel,
      text: "different-ai/openwork v0.18.38 is published. Generated release notes: https://github.com/different-ai/openwork/releases/tag/v0.18.38\nPublication is not approval for customer rollout.",
      mrkdwn: false,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    });
    assert.equal(release.body, `${stable.body}\n\n${sent}`);
    assert.deepEqual(await run(), { status: "skipped", reason: "already-sent" });
    assert.deepEqual(await trace(), [get, patch, post, patch, get]);
    await proved("A stable release posts exactly once to the configured channel with only the canonical link, no untrusted title/body/mentions, and separate provider credentials");

    for (const field of Object.keys(config)) {
      for (const value of [undefined, "", " \t "]) {
        await reset();
        assert.deepEqual(await run({ [field]: value }), { status: "skipped", reason: "missing-config" });
        assert.deepEqual(requestedUrls, []);
        assert.deepEqual(await trace(), []);
        assert.deepEqual(requests, []);
        await proved(`Missing ${field} (${JSON.stringify(value)}) makes no provider request`);
      }
    }
    for (const invalid of [
      ...["0.18.38", "v0.18", "v0.18.38-beta.1", "v0.18.38+build", "v0.18.38\n", "v0.18.38/../latest", "v0.18.38<!channel>"].map((tag) => ({ tag })),
      { repository: "different-ai/openwork/../other" },
      { repository: "different-ai/.." },
      { channel: "#releases" },
      { channel: "C012RELEASE\n" },
    ]) {
      await reset();
      await assert.rejects(run(invalid), { message: "Invalid release notification configuration." });
      assert.deepEqual(requestedUrls, []);
      assert.deepEqual(await trace(), []);
      assert.deepEqual(requests, []);
      await proved(`Invalid configuration ${JSON.stringify(invalid)} cannot reach a provider`);
    }
    for (const excluded of [
      { draft: true }, { prerelease: true }, { published_at: null }, { published_at: "" },
      { tag_name: "v0.18.39" }, { tag_name: "v0.18.38-beta.1" },
    ]) {
      await reset(excluded);
      assert.deepEqual(await run(), { status: "skipped", reason: "not-published-stable-release" });
      assert.deepEqual(await trace(), [get]);
      assert.equal(release.body, stable.body);
      await proved(`Release ${JSON.stringify(excluded)} is read but never patched or posted`);
    }
    for (const invalid of [{ id: 0 }, { draft: "false" }, { body: {} }, { published_at: 42 }]) {
      await reset(invalid);
      await assert.rejects(run(), { message: "Invalid GitHub release response." });
      assert.deepEqual(await trace(), [get]);
      await proved(`Malformed GitHub release ${JSON.stringify(invalid)} fails closed`);
    }
    for (const markers of [[pending], [sent], [pending, sent]]) {
      const directory = await mkdtemp(join(tmpdir(), "slack-release-notes-"));
      let body: string;
      try {
        const docs = join(directory, "changelog.mdx");
        const existing = join(directory, "existing.md");
        await writeFile(docs, `## [${config.tag}](https://github.com/${config.repository}/compare/v0.18.37...${config.tag}): Updated notes\n\n- A documented fix.\n`);
        await writeFile(existing, `${stable.body}\n\n${markers.join("\n")}`);
        const generated = await promisify(execFile)(process.execPath, [
          fileURLToPath(new URL("../../scripts/release/release-notes-from-changelog.mjs", import.meta.url)),
          config.tag, "--docs", docs, "--existing-body", existing,
        ], { timeout: 10_000 });
        body = generated.stdout;
        assert(body.includes("A documented fix."));
        assert(!body.includes("UNTRUSTED BODY"));
        for (const marker of [pending, sent]) assert.equal(body.includes(marker), markers.includes(marker));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      await reset({ body });
      const result = markers.includes(pending)
        ? { status: "pending", reason: "manual-reconciliation-required" }
        : { status: "skipped", reason: "already-sent" };
      assert.deepEqual(await run(), result);
      assert.deepEqual(await run(), result);
      assert.deepEqual(await trace(), [get, get]);
      assert.equal(release.body, body);
      await proved(`${markers.join(" + ")} survives actual release-note regeneration and suppresses all writes on repeated runs`);
    }
    for (const failure of ["lookup", "prewrite", "unconfirmed-prewrite"]) {
      await reset();
      if (failure === "unconfirmed-prewrite") unconfirmedPatch = true;
      else await proxy.faults.status(failure === "lookup" ? lookupPath : patchPath, 503);
      await assert.rejects(run(), { message: failure === "lookup" ? "GitHub release lookup failed."
        : failure === "prewrite" ? "GitHub notification marker update failed."
          : "GitHub notification marker update was not confirmed." });
      assert.deepEqual(await trace(), failure === "lookup" ? [get] : [get, patch]);
      assert.equal(release.body, stable.body);
      assert.equal(requests.filter((entry) => entry.path === slackPath).length, 0);
      await proved(`${failure} prevents Slack from being called without a confirmed durable pending marker`);
    }
    for (const failure of [
      { name: "rejected", reply: { ok: false, error: `${config.slackToken} rejected` } },
      { name: "wrong-channel", reply: { ok: true, channel: "COTHER", ts: "123.456" } },
      { name: "missing-timestamp", reply: { ok: true, channel: config.channel } },
      { name: "blank-timestamp", reply: { ok: true, channel: config.channel, ts: " " } },
      { name: "null", reply: null },
      { name: "malformed" }, { name: "http-429" }, { name: "http-503" }, { name: "timeout" },
    ]) {
      await reset();
      slackReply = failure.reply;
      slackMode = failure.name;
      if (failure.name.startsWith("http-")) {
        await proxy.faults.status(slackPath, Number(failure.name.slice(5)), { body: { error: config.slackToken } });
      }
      const transportFailure = ["malformed", "http-429", "http-503", "timeout"].includes(failure.name);
      await assert.rejects(run(), { message: transportFailure ? "Slack notification request failed."
        : "Slack notification was not confirmed; the release remains pending." });
      if (failure.name === "timeout") assert.equal(slackSignals.at(-1)?.aborted, true);
      assert.equal(release.body, `${stable.body}\n\n${pending}`);
      assert.deepEqual(await trace(), [get, patch, post]);
      assert.deepEqual(await run(), { status: "pending", reason: "manual-reconciliation-required" });
      assert.deepEqual(await trace(), [get, patch, post, get]);
      assert.equal(release.body, `${stable.body}\n\n${pending}`);
      await proved(`Slack ${failure.name} leaves pending, sanitizes provider errors, and never retries on rerun`);
    }
    await reset();
    failFinalPatch = true;
    await assert.rejects(run(), { message: "GitHub notification marker update failed." });
    assert.equal(release.body, `${stable.body}\n\n${pending}`);
    assert.equal(requests.filter((entry) => entry.path === slackPath).length, 1);
    assert.deepEqual(await trace(), [get, patch, post, patch]);
    assert.deepEqual(await run(), { status: "pending", reason: "manual-reconciliation-required" });
    assert.deepEqual(await trace(), [get, patch, post, patch, get]);
    assert.equal(release.body, `${stable.body}\n\n${pending}`);
    await proved("A confirmed Slack send followed by a failed final PATCH preserves pending and cannot produce another POST");
  } finally {
    await new Promise<void>((resolve, reject) => {
      witness.close((error) => error ? reject(error) : resolve());
      witness.closeAllConnections();
    });
  }
});
