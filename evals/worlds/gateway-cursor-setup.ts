import { connect } from "node:net";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { gatewayEnvironment, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { isRecord } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * Cursor setup (part of `gatewayMemberApiKeys`): a real Den (cloud) and AI Gateway with one Anthropic-protocol
 * provider whose only upstream is the deterministic Acme mock, every member allowed its model, member
 * API keys and Cursor setup on for the seeded organization, 3rd party tools allowed, and the owner
 * signed in on My Library › Models.
 */
export async function gatewayCursorSetupWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "Cursor setup proof", admin: { name: "Cursor owner" } } }));
    if (!den.database) throw new Error("The Cursor setup world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const provider = await seedAcmeGateway(den.admin, upstream);
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { gatewayMemberApiKeys: true });
    const allowed = await seed.api(den.admin, "/v1/org/ai-gateway-settings", { method: "PUT", body: JSON.stringify({ memberApiKeys: true }) });
    if (!allowed.response.ok) throw new Error(`Allowing 3rd party tools failed: HTTP ${allowed.response.status} ${allowed.text.slice(0, 300)}`);
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/library?show=models", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      organizationId,
      provider,
      upstream,
      gatewayUrl: gateway.baseUrl,
      apiKeysTabUrl: `${den.ref.webUrl}/dashboard/ai-gateway?tab=api-keys`,
      /** Ages every session past the step-up window, so the next workspace setting change asks to confirm it's you. */
      async ageSessions() {
        const database = den.database?.url;
        if (!database || !new URL(database).pathname.startsWith("/openwork_eval_")) throw new Error("Aging sessions needs the isolated testkit database.");
        await queryDenDatabase(database, "UPDATE session SET created_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 2 DAY)");
        // Den caches sessions in Redis; drop the cached copies (never revocations) so it reads the aged rows.
        await dropCachedSessions(process.env.DATABASE_REDIS_URL || "redis://127.0.0.1:6379");
      },
      /** A key for Cursor, created as the owner would in My Library › Models. */
      async createApiKey(name: string): Promise<string> {
        const created = await seed.api(den.admin, "/v1/org/ai-gateway/api-keys/mine", { method: "POST", body: JSON.stringify({ name }) });
        const key = isRecord(created.body) ? created.body.key : null;
        if (!created.response.ok || typeof key !== "string") throw new Error(`Creating the API key failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
        return key;
      },
      /** A request as Cursor sends it: the OpenAI key header and an absolute URL under the base URL it was given. */
      async callAsCursor(key: string, url: string, body?: unknown) {
        const response = await fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: response.status, json, text };
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

/** Deletes Den's cached session lookups (`cache:auth:session:*`) with plain RESP: SCAN, then DEL. */
async function dropCachedSessions(redisUrl: string): Promise<void> {
  const url = new URL(redisUrl);
  const socket = connect({ host: url.hostname, port: Number(url.port || 6379) });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => { buffer += chunk; });
  const encode = (args: string[]) => `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`;
  /** Reads one RESP value from the buffer, or undefined while it is incomplete. */
  const parse = (text: string, at = 0): { value: unknown; end: number } | undefined => {
    const line = text.indexOf("\r\n", at);
    if (line < 0) return undefined;
    const head = text.slice(at + 1, line);
    switch (text[at]) {
      case "+": case "-": return { value: head, end: line + 2 };
      case ":": return { value: Number(head), end: line + 2 };
      case "$": {
        const length = Number(head);
        if (length < 0) return { value: null, end: line + 2 };
        if (text.length < line + 2 + length + 2) return undefined;
        return { value: text.slice(line + 2, line + 2 + length), end: line + 2 + length + 2 };
      }
      case "*": {
        const items: unknown[] = [];
        let end = line + 2;
        for (let index = 0; index < Number(head); index += 1) {
          const item = parse(text, end);
          if (!item) return undefined;
          items.push(item.value);
          end = item.end;
        }
        return { value: items, end };
      }
      default: throw new Error(`Unexpected Redis reply: ${text.slice(at, at + 40)}`);
    }
  };
  const command = async (args: string[]): Promise<unknown> => {
    buffer = "";
    socket.write(encode(args));
    for (let waited = 0; waited < 5000; waited += 10) {
      const reply = parse(buffer);
      if (reply) return reply.value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Redis did not answer ${args[0]}.`);
  };
  try {
    let cursor = "0";
    do {
      const reply = await command(["SCAN", cursor, "MATCH", "cache:auth:session:*", "COUNT", "1000"]);
      if (!Array.isArray(reply) || typeof reply[0] !== "string" || !Array.isArray(reply[1])) throw new Error("Unexpected SCAN reply.");
      cursor = reply[0];
      const keys = reply[1].filter((key): key is string => typeof key === "string");
      if (keys.length) await command(["DEL", ...keys]);
    } while (cursor !== "0");
  } finally {
    socket.end();
  }
}
