import { denFetch } from "@openwork/behaviors";
import { browserScript, evaluate } from "@openwork/cdp";
import type { DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { isRecord, records, stringField } from "./library.ts";

/** A private Den and a local OAuth MCP, with two genuinely separate member accounts. */
export async function libraryConnectorNavigation(seed: Seed) {
  const den = await seed.den({
    org: { name: "Review studio", admin: { name: "Library Owner" }, members: { peer: { name: "Library Teammate" } } },
    mocks: {
      connector: seed.mock({ isolatedProcessEnv: true }),
      unassigned: seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true }),
    },
  });
  const connection = await seed.orgConnection(den.admin, {
    name: "Review notes", url: den.mocks.connector.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true },
  });
  const unassigned = await seed.orgConnection(den.admin, {
    name: "Unassigned notes", url: den.mocks.unassigned.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: false },
  });
  // The teammate has already signed in. The owner signs in through the UI in the proof.
  // Follow the local provider's genuine OAuth redirect; never write an account/token row.
  const peerStart = await seed.api(den.members.peer, `/v1/mcp-connections/${connection.id}/connect/start`);
  const authorizeUrl = stringField(peerStart.body, "authorizeUrl");
  if (!peerStart.response.ok || !authorizeUrl) throw new Error(`Starting the teammate's sign-in failed: ${peerStart.text}`);
  if (new URL(authorizeUrl).origin !== new URL(den.mocks.connector.url).origin) throw new Error("OAuth must stay on the local fixture.");
  const authorized = await fetch(authorizeUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const location = authorized.headers.get("location");
  if (authorized.status !== 302 || !location) throw new Error("The local OAuth provider did not return a callback.");
  const callbackUrl = new URL(location, authorizeUrl);
  if (callbackUrl.origin !== new URL(den.ref.apiUrl).origin && callbackUrl.origin !== new URL(den.ref.webUrl).origin) throw new Error("OAuth callback escaped the private Den.");
  const callback = await fetch(callbackUrl, { signal: AbortSignal.timeout(30_000) });
  if (!callback.ok) throw new Error(`The teammate's OAuth callback failed: ${callback.status}`);

  const pluginName = "Review toolkit";
  const skillDescription = "Plan a focused review with clear decisions.";
  const skillBody = "Read the supplied notes.\n\n1. List the unresolved questions.\n2. Assign each question an owner.\n3. End with a dated review agenda.";
  const rawSourceText = `---\nname: plan-a-review\ndescription: ${skillDescription}\n---\n\n${skillBody}`;
  const created = await seed.api(den.admin, "/v1/plugins", {
    method: "POST", body: JSON.stringify({ name: pluginName, components: [
      { type: "skill", input: { rawSourceText } },
      { type: "skill", input: { rawSourceText: "---\nname: capture-decisions\ndescription: Keep the outcome of a review.\n---\n\nRecord each decision, its owner, and its due date." } },
    ] }),
  });
  const pluginId = stringField(isRecord(created.body) ? created.body.item : null, "id");
  if (!created.response.ok || !pluginId) throw new Error(`Creating the review plugin failed: ${created.text}`);

  // A plugin that is one skill, with more steps than the preview shows.
  const singlePluginName = "Meeting follow-up";
  const singleSteps = Array.from({ length: 12 }, (_, index) => `${index + 1}. Follow-up step ${index + 1}.`);
  const single = await seed.api(den.admin, "/v1/plugins", {
    method: "POST", body: JSON.stringify({ name: singlePluginName, components: [
      { type: "skill", input: { rawSourceText: `---\nname: write-a-follow-up\ndescription: Send a clear follow-up after a meeting.\n---\n\n${singleSteps.join("\n")}` } },
    ] }),
  });
  const singlePluginId = stringField(isRecord(single.body) ? single.body.item : null, "id");
  if (!single.response.ok || !singlePluginId) throw new Error(`Creating the one-skill plugin failed: ${single.text}`);

  const web = await seed.web({
    den, signedInAs: den.admin,
    startPath: `/dashboard/mcp-connections/${connection.id}`,
    headless: true, viewport: { width: 1440, height: 1000 },
  });
  await web.client.send("Network.enable");
  await web.client.send("Network.setBlockedURLs", { urls: ["https://www.google.com/s2/favicons*"] });

  async function connectionState(session: DenSession) {
    const result = await denFetch(session, "/v1/mcp-connections?scope=usable", { headers: { authorization: `Bearer ${session.token}` } });
    if (!result.response.ok) throw new Error(`Reading connection state failed: ${result.response.status}`);
    return (isRecord(result.body) ? records(result.body.connections) : []).find(row => row.id === connection.id);
  }

  return {
    den, web, connection, unassigned, pluginName, pluginId, skillDescription, skillBody,
    singlePluginName, singlePluginId, singleFirstLine: singleSteps[0] ?? "", singleLastLine: singleSteps.at(-1) ?? "",
    url: (path: string) => `${den.ref.webUrl}${path}`,
    async accounts() {
      const [owner, peer] = await Promise.all([connectionState(den.admin), connectionState(den.members.peer)]);
      return { owner: owner?.connectedForMe === true, peer: peer?.connectedForMe === true, exists: Boolean(owner), orgWide: isRecord(owner?.access) && owner.access.orgWide === true };
    },
    async assignedConnectionIds() {
      const result = await denFetch(den.admin, "/v1/me/library", { headers: { authorization: `Bearer ${den.admin.token}` } });
      if (!result.response.ok || !isRecord(result.body)) throw new Error(`Reading My Library failed: ${result.response.status}`);
      return records(result.body.items).filter(row => row.type === "connection").map(row => row.id);
    },
    async failPluginReads() {
      await web.client.send("Network.setBlockedURLs", { urls: ["https://www.google.com/s2/favicons*", `*/v1/plugins/${pluginId}*`] });
    },
    async restorePluginReads() {
      await web.client.send("Network.setBlockedURLs", { urls: ["https://www.google.com/s2/favicons*"] });
    },
    async pluginReads(id = pluginId) {
      // Read Chromium's actual resource timings, without proxying the auth or web origins.
      return evaluate(web.client, browserScript((path) => performance.getEntriesByType("resource")
        .filter(entry => new URL(entry.name).pathname.endsWith(path)).length, [`/v1/plugins/${id}`]));
    },
    async tokenFingerprints() {
      return [...new Set((await den.mocks.connector.requests()).filter(request => request.grantType === "authorization_code" && request.status === 200).flatMap(request => request.tokenId ? [request.tokenId] : []))];
    },
  };
}
