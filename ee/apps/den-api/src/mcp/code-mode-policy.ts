import { readOrganizationMetadata } from "@openwork/types/den/managed-models-policy"

/**
 * Effective Code Mode presentation for an organization. The stored opt-in is
 * inert unless the deployment enables it: no published OpenWork engine keeps
 * app-only routers out of the model-facing catalog yet, so a Den deployment
 * must not change its MCP catalog on a stored flag alone.
 */
export function organizationCodeModeEnabled(metadata: unknown, options: { optInEnabled: boolean }): boolean {
  return options.optInEnabled && readOrganizationMetadata(metadata).codeModeEnabled === true
}

/**
 * Settings writes may turn Code Mode on only when the deployment enables the
 * opt-in. Turning it off is always allowed so a stale stored flag can be
 * cleared, and omitting the field never counts as a change.
 */
export function codeModeSettingWriteAllowed(requested: boolean | undefined, options: { optInEnabled: boolean }): boolean {
  return requested !== true || options.optInEnabled
}

export const CODE_MODE_INSTRUCTIONS = [
  "Use execute_capability_script as the primary tool for connected work. Discover authorized actions and shared Workflows inside a script with tools.$codemode.search({query}); results contain items with path, description and signature. Invoke the exact tools expression in a returned signature with its advertised arguments. Try 2-4 keyword variants before concluding an action is unavailable. Each call runs with the current member's permissions.",
  "Use Promise.all for independent calls. End scripts with return of JSON-safe data. Saved Workflows must use discovered paths directly rather than dynamic discovery. Nested Workflows share a bounded call budget and deadline; do not use recursion.",
  "When a retrieved skill describes capability discovery or execution, use Code Mode discovery and calls in this mode. Search descriptions and signatures before saving or sharing. After successful Plugin sharing, use plugin_flow to present the existing sharing confirmation card.",
  "Use capability_helper only for explicit connection setup, sign-in/status cards, MCP App launches, or remote sessions. It preserves host app bindings and connection actions. Do not put MCP App launches in scripts. Direct tools for skills, Workflow Artifacts and artifact views remain available; use those tools for their own flows.",
  "If a requested action is unavailable or needs sign-in, query capability_helper for that service. Use intent connect only when the user asked to connect; otherwise relay the exact connection action only when the requested work needs it. Do not probe again if a connectionAction card was returned. Use type connectors to browse quick adds. For work requested on the remote session, discover and launch the remote-session helper with the whole request, then poll its reply rather than performing that work here.",
  "Save a Workflow only when the user explicitly asks to save. Discover saveWorkflow inside Code Mode. Pass the existing Plugin the user selected, or omit pluginId for a private Workflow in My Workflows. Saving does not authorize sharing. Share with a team only after confirming the target Plugin, team and access: existing Plugin sharing covers every object in that Plugin and may expose saved Workflow outputs. Never grant access to My Workflows or unrelated Plugin content just to share one Workflow. Reuse existing Plugin/team access; do not invent Workflow grants.",
  "Code Mode retains private procedure attempts separately from executions for up to 15 minutes, including failures; they are not library Workflows. receiptId is the canonical stored version ID and runId/status describe execution. To Keep as Workflow, discover saveWorkflow and send only {receiptId, name}, optionally description/pluginId; never reconstruct code, input or schemas and never send title. Inspect private attempts with getWorkflowAuthoringHistory. Promotion requires a matching successful run and current security/capability checks. Run the saved Workflow using its returned IDs; multiple runs are results of that Workflow, not new library entries.",
  "Live artifact views require a successful live authoring test with outputSchema, saving with receiptId and name only, and a successful saved live run before save_artifact_view. Live scripts receive server-supplied input.runtime; never supply caller input. The user previews the draft and chooses Save. Only create Automations when asked for a schedule.",
].join("\n")
