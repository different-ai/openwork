import type { Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The shape of Slack's public MCP metadata, so the Slack preset's setup page
 * never reaches the real provider: an OAuth server that only accepts
 * pre-registered apps. It advertises a shorter scope list than the preset on
 * purpose, so a request that matches the Slack app manifest proves the
 * admin's explicit choice won.
 */
const SLACK_DISCOVERY = {
  status: "manual_action_required",
  server: { url: "https://mcp.slack.com/mcp", initialize: "authentication_required" },
  authentication: {
    kind: "oauth",
    resource: "https://mcp.slack.com",
    authorizationServers: [{
      issuer: "https://mcp.slack.com",
      authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
      tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
      clientIdMetadataDocumentSupported: false,
      tokenEndpointAuthMethodsSupported: ["client_secret_post"],
    }],
    requiredScopes: [],
    recommendedScopes: ["canvases:write", "files:write", "search:read.public", "chat:write", "users:read"],
    refreshSupport: "not_advertised",
    availableRegistrationMethods: ["pre_registered"],
    recommendedRegistrationMethod: "pre_registered",
  },
  tools: { visibility: "requires_auth" },
  manualRequirements: [],
  warnings: [],
};

/**
 * An organization admin on Manage › Connectors › Add connector › Slack, with
 * guided Slack setup available by default, without feature setup.
 * Den is real; only the browser's discovery request for Slack's address is
 * answered from the fixture above, through a second CDP connection on the
 * same page (no renderer JavaScript). Nobody signs in to real Slack.
 */
export async function denSlackGuidedSetup(seed: Seed) {
  const den = await seed.den({ org: { name: "Fieldnotes Studio", admin: { name: "Connector Admin" } } });
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections", headless: true, viewport: { width: 1280, height: 1500 } });
  await web.client.send("Network.enable");
  await web.client.send("Network.setBlockedURLs", { urls: ["https://www.google.com/s2/favicons*"] });

  const endpoint = web.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("The Slack setup world needs the page's CDP endpoint.");
  const socket = new WebSocket(endpoint);
  let sequence = 0;
  let discoveries = 0;
  const send = (method: string, params: Record<string, unknown>) => socket.send(JSON.stringify({ id: ++sequence, method, params }));
  socket.addEventListener("message", ({ data }) => {
    const message: unknown = JSON.parse(String(data));
    if (!isRecord(message) || message.method !== "Fetch.requestPaused" || !isRecord(message.params)) return;
    const { requestId, request } = message.params;
    if (typeof requestId !== "string" || !isRecord(request)) return;
    if (request.method !== "POST" || typeof request.postData !== "string" || !request.postData.includes("mcp.slack.com")) {
      send("Fetch.continueRequest", { requestId });
      return;
    }
    discoveries += 1;
    send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "Access-Control-Allow-Origin", value: new URL(den.ref.webUrl).origin },
        { name: "Access-Control-Allow-Credentials", value: "true" },
        { name: "Cache-Control", value: "no-store" },
      ],
      body: Buffer.from(JSON.stringify(SLACK_DISCOVERY)).toString("base64"),
    });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Slack setup world: CDP connection timed out.")), 15_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Slack setup world: CDP connection failed.")); }, { once: true });
  });
  send("Fetch.enable", { patterns: [{ urlPattern: "*/v1/mcp-connections/discover*", requestStage: "Request" }] });

  return {
    web,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    discoveries: () => discoveries,
    async presets() {
      const result = await seed.api(den.admin, "/v1/mcp-connections/presets");
      return isRecord(result.body) && Array.isArray(result.body.presets) ? result.body.presets.filter(isRecord) : [];
    },
    async slackConnection() {
      const result = await seed.api(den.admin, "/v1/mcp-connections?scope=manageable");
      const connections = isRecord(result.body) && Array.isArray(result.body.connections) ? result.body.connections.filter(isRecord) : [];
      return connections.find((entry) => entry.url === "https://mcp.slack.com/mcp");
    },
    async [Symbol.asyncDispose]() { socket.close(); },
  };
}
