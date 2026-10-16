import { skillsExtensionServerCapabilities } from "./skills-extension.js"
import { McpServer } from "@modelcontextprotocol/server"
import { workflowArtifactAppServerCapabilities } from "./workflow-artifact-app.js"
import { REMOTE_SESSION_RECEIPT_INSTRUCTIONS } from "./remote-session-resources.js"

/**
 * Connect steering routes requests; it does not repeat tool rules. With App
 * servers on, App requests go to the built-in build-an-app skill, which owns
 * the process, quality bar, and detailed source/tool-call contract.
 * create_app summarizes publication; search_capabilities owns search coverage.
 * With them off (DEN_APP_MCP_SERVERS_ENABLED=false or member-facing MCP
 * connections disabled), the previous Workflow-bound save_artifact_view
 * guidance applies unchanged.
 */
function agentMcpDetailedInstructions(appServers: boolean): string {
  return [
    "When asked what can be connected or to browse quick adds, call search_capabilities with type connectors and any descriptive query. This returns the legacy version 1 connectorCatalog envelope, including Google Workspace and Microsoft 365. Released clients may render their existing browse catalog; new clients intentionally ignore it. No new setup card is introduced. Setup options are not executable capabilities or proof of connection. Organization administrators manage setup in the organization Connections dashboard. Named-service searches include legacy setup suggestions only with explicit intent connect, type omitted, all, or mcp, and no matching mcp connection; modern clients ignore these catalogs. Never invent credentials or claim setup is finished. Existing connection actions take priority.",
    "This OpenWork Cloud MCP server uses standard MCP tools, resources, structured results, and list-changed notifications.",
    "For connection actions and saved Workflows, call search_capabilities with 2-4 keyword variants before concluding something is unavailable. Use execute_capability only with exact names returned by search_capabilities. A successful search_capabilities call proves this connection is authorized: Never tell the user to reconnect OpenWork Cloud because a downstream connector failed.",
    "Capabilities include native Google Workspace operations (Gmail read/search, Calendar list/create, Drive search/read, and Gmail draft creation) executed with the signed-in member's organization credentials; to analyze or edit whole Drive files, follow the drive-files skill, plus any MCP connections the organization has added. Allowlisted platform admins also discover namespaced OpenWork Admin capabilities here; other members cannot.",
    "A remote session offloads work to a native chat on OpenWork Cloud, an OpenWork desktop, or an opted-in OpenCode client. The default target is the member's OpenWork Web instance, running in the cloud and visible in the browser. When asked to do something \"on the remote session\", \"in the web\", or \"in the cloud\" (e.g. \"run a Slack search for messages on the remote session\"), do not do the work here: execute remote-session:create with the whole request as prompt (or remote-session:send to an existing sessionId), then poll remote-session:read and relay the reply. target \"desktop\" runs it on the member's connected desktop instead and returns a commandId: poll remote-session:read with that commandId until state is failed or expired, or session.status is idle (relay session.finalText) or error (relay session.lastError). When session.status is waiting, tell the person to answer the session.waitingFor prompt (permission or question) in their OpenWork desktop. session stays null on desktops that do not report progress. For a desktop session, remote-session:read with its sessionId returns the transcript (page with from and nextCursor), remote-session:send sends a follow-up (then poll with the commandId again), and remote-session:stop stops it; if one of these returns state pending with a requestId, read that requestId later. remote-session:list with target desktop lists the member's desktop sessions. When the request names a specific computer, workspace, or model, first execute remote-session:targets (includeModels true when a model matters), then pass its computerId, workspaceId, and model to remote-session:create with target \"desktop\"; remote-session:read with commandId reports which computer took it. When the create result has resultPostedInThread: true (a Slack run), OpenWork itself posts the outcome to that Slack thread: tell the person so and end your turn instead of polling. For later status questions, call remote-session:read with the commandId instead of guessing.",
    "For an opted-in OpenCode client or another registered computer, call remote-session:targets first and use remote-session:create with target registered and its computerId (plus workspaceId/model when needed). This does not provision Cloud. Follow the same commandId/read/send/stop flow as desktop sessions. Native OpenCode reads expose recent context, not guaranteed history before compaction. Never blindly repeat a create whose outcome is unknown: inspect its commandId first; ambiguous_creation means a native session might exist and needs local inspection. Slack and chat use these same MCP capabilities and owner-scoped receipts; do not invent a separate bot registration or approval bypass.",
    "Use create_skill to create one private Cloud skill in a new Plugin, and update_skill to publish a new immutable version of an existing skill. Both return text and structured skill details; do not route these flows through execute_capability, postPlugins, or postConfigObjectsVersions.",
    "Skills have direct tools: list_skills returns every built-in and marketplace skill this member may use, and get_skill returns one skill's SKILL.md by its name or exact capability. Prefer them over keyword search for skills; search_capabilities with type skills and execute_capability still return the same skills, and the skill:// resources are unchanged.",
    "Built-in remote skills create-skill, share-plugin, add-to-marketplace, and add-user-to-marketplace are always listed by list_skills and in the skill index. Retrieve and follow the matching one with get_skill (or by executing its exact capability); do not invent a local copy.",
    appServers ? "To build or change an App (a dashboard, tracker, lookup, form, calculator, or other interactive view), read the build-an-app skill with get_skill and follow it. It uses the direct prepare_app, create_app, read_app, and update_app tools, whose presence means App building is on; never substitute save_artifact_view, config-object writes, or a local HTML file. Create a Workflow only for a reusable procedure, and an Automation only when the user asks for a schedule." :"For an app, dashboard, or artifact view of Workflow results, call the direct MCP tool save_artifact_view and follow its prerequisites. It is a Cloud MCP tool, not a desktop-only RPC or a search_capabilities match. Its presence in the available tools confirms availability; an empty capability search does not establish a disabled feature flag. Do not substitute a local HTML file for an in-app artifact. Build the complete app in one shot without asking about Workflow internals, names, or runtime code. Live workflows use server-supplied input.runtime for current dates and caller timezone. Use one friendly name for the workflow and app; the user previews the draft and chooses Save to keep both on their dashboard. Only create an Automation when the user asks for a schedule.",
    "Skills teach how to perform work. Workflows are saved procedures discovered through search_capabilities and run through execute_capability. Author an ad hoc procedure with execute_capability_script; Workflow runs produce artifacts rendered by render_workflow_artifact, and Automations trigger Workflows. To keep a successful Code Mode result, save it as a Workflow inside the existing Plugin the member names (pass that pluginId); omit pluginId only for a private Workflow in their My Workflows Plugin. A Workflow inherits discovery and sharing from its Plugin and Marketplaces; never create a separate Workflow package or marketplace entry.",
    "To open an App, execute its kind mcp_app match from search_capabilities. Never import, convert, or browse for a standalone HTML URL instead; standalone URL-imported Apps are not part of this release.",
    "To add a public GitHub plugin to an organization marketplace, search for the marketplace list, GitHub plugin import preview, GitHub plugin marketplace import, and resolved marketplace detail capabilities. Preview first; do not recreate the plugin by hand. Before importing, confirm the target marketplace, selected skill/server keys, and who can use them; omitting selectedSkillKeys imports every supported skill. A marketplace repository (for example a Claude Cowork marketplace) lists each plugin in the preview: import one plugin per call with its folder URL (https://github.com/<owner>/<repo>/tree/<branch>/<plugin folder>). Importing the same plugin again from the same repository updates it in place (mode: updated, with updatedSkills and unchanged), so a migration can be re-run safely; skills and MCP servers deleted upstream since the last import are removed from the plugin and listed in removed, while components added by hand are kept. Do not choose one authentication type for every server: the import route resolves known presets and plugin declarations, and the request authType is only a fallback for unknown servers. Claude-specific connectors are mapped to what OpenWork already knows: each preview server reports mapsTo (a preset, or native Google Workspace / Microsoft 365) and reuse (the organization's existing connection it will use); tell the person it uses their existing <reuse.connectionName> connection instead of promising a new one. Servers skipped as native_connector are Claude-only; relay connecting that provider in OpenWork as the next step.",
    "After importing, retrieve the resolved marketplace detail and report each plugin's cloudReadiness. An import or plugin binding is not proof that an MCP connection is usable: relay needs_admin_setup or needs_signin as the next human action instead of claiming the connection is ready. Connectors from Claude/Cowork plugins are optional: their skills work immediately, and get_skill lists each optional connection with how to connect it.",
    "Do not invent OAuth-client, credential, or local-extension setup. Organization connections are managed in the OpenWork Cloud dashboard / Settings > Connect; when a connection or marketplace readiness state requires administrator setup or member sign-in, relay that exact action.",
    "External MCP matches include the provider-advertised argumentsSchema, schemaDigest, and invocation.argumentsField. Put an object matching argumentsSchema in execute_capability.body and copy schemaDigest into execute_capability.schemaDigest. OpenWork always attempts the downstream provider call even when local schema checks find a mismatch; schemaGuidance is advisory (returned as openwork/schemaGuidance alongside provider results): if the provider succeeded, accept the result and do not retry because of the warning; if it failed, use the warning to correct the arguments or search again.",
    "If the provider returns invalid_capability_arguments, correct the listed issues and retry once with changed arguments; never retry the same arguments unchanged. If it returns unknown_capability, call search_capabilities again before retrying.",
    "When the user explicitly asks to connect or reconnect a service, search for that service by name with intent connect. Ordinary capability searches must omit intent connect: blocked connection matches are informational and must not trigger sign-in cards or automatic status calls. Only propose authorization when an explicitly requested operation actually depends on that connection. Explicit connection searches render a card when the result identifies one connection. Do not execute the same status again when the search response includes connectionAction. For an explicit connection request without a card, execute that exact status match once. When execute_capability fails with needs_connection or connection_not_connected, execute that connection's status capability (mcp:<connectionId>:*) once for the same card. For member-owned OAuth connections in OpenWork desktop, ask the user to click Connect or Reconnect on the inline card; desktop handles authorization directly, so do not send them to Den. For other actions, name connectionStatus.connectionName and relay connectionStatus.action exactly in text, distinguishing the member's Your Connections page, the organization Connections dashboard, and the provider's own admin console. Probes are live: after the human fixes the connector, search again in the same task; otherwise do not retry unchanged or improvise workarounds through other tools.",
    "Successful postMarketplacesPlugins, postPluginsAccess, and postMarketplacesAccess calls return the ordinary operation response; report the verified outcome in text.",
  ].join("\n")
}

export const AGENT_MCP_GUIDANCE_URI = "openwork://agent/guidance.md"

function agentMcpInstructions(appServers: boolean): string {
  return [
    `Read ${AGENT_MCP_GUIDANCE_URI} with resources/read before working; it contains the full connection, remote-session, import, and Workflow rules.`,
    "Search capabilities with 2-4 keyword variants; execute only exact returned names. Copy external argumentsSchema into body and schemaDigest into schemaDigest. Schema guidance is advisory; never repeat a successful provider call because of it.",
    "Only use intent connect for an explicit connect/reconnect request. Discovery must not trigger sign-in. Relay the connection's exact action; a downstream failure does not mean OpenWork needs reconnecting. Never invent credentials or claim setup is ready.",
    "Use list_skills/get_skill for authorized skills and follow the matching skill before creating or sharing one. update_skill publishes an immutable version.",
    appServers
      ? "For Apps read build-an-app with get_skill, then use prepare_app/create_app/read_app/update_app; never substitute local HTML or legacy views. Open Apps via their discovered capability."
      : "For Workflow result views use save_artifact_view and follow its prerequisites; never substitute local HTML.",
    "Honor requests to work remotely by delegating the whole request with remote-session:create/send, then reading its receipt; do not perform that work here. Only schedule an Automation when asked.",
  ].join("\n")
}

export const AGENT_MCP_INSTRUCTIONS = agentMcpInstructions(true)
export const LEGACY_AGENT_MCP_INSTRUCTIONS = agentMcpInstructions(false)

/** Rolled out with `remote-session:status`; one rule, the details live in its description. */
const REMOTE_SESSION_STATUS_INSTRUCTIONS = "To follow remote sessions, call remote-session:status with all of their commandIds or Cloud sessionIds and waitMs instead of calling remote-session:read repeatedly; read only for the transcript or the full answer."

export function createAgentMcpServer(options: { appServers?: boolean; remoteSessionEvents?: boolean; remoteSessionStatus?: boolean } = {}): McpServer {
  const server = new McpServer({
    name: "openwork-den-api-agent",
    version: "1.0.0",
    title: "OpenWork Connect",
    description: "Discover and use your organization's authorized connections, skills, and Workflows; build Apps and delegate work to OpenWork sessions.",
    websiteUrl: "https://openworklabs.com",
    icons: [{ src: "https://openworklabs.com/openwork-logo.svg", mimeType: "image/svg+xml", sizes: ["any"] }],
  }, {
    capabilities: {
      extensions: { ...workflowArtifactAppServerCapabilities.extensions, ...skillsExtensionServerCapabilities },
      tools: { listChanged: true },
      resources: { listChanged: true, ...(options.remoteSessionEvents ? { subscribe: true } : {}) },
    },
    instructions: [options.appServers === false ? LEGACY_AGENT_MCP_INSTRUCTIONS : AGENT_MCP_INSTRUCTIONS,
      ...(options.remoteSessionEvents ? [REMOTE_SESSION_RECEIPT_INSTRUCTIONS] : []),
      ...(options.remoteSessionStatus ? [REMOTE_SESSION_STATUS_INSTRUCTIONS] : [])].join("\n"),
  })
  server.registerResource("agent-guidance", AGENT_MCP_GUIDANCE_URI, {
    title: "OpenWork agent guidance",
    description: "Full operating rules for connections, remote sessions, skills, Apps, Workflows, and plugin imports. Read before using the gateway.",
    mimeType: "text/markdown",
  }, async () => ({
    contents: [{
      uri: AGENT_MCP_GUIDANCE_URI,
      mimeType: "text/markdown",
      text: agentMcpDetailedInstructions(options.appServers !== false),
    }],
  }))
  return server
}
