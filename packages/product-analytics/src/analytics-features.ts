export type AnalyticsProperties = Record<string, string | number | boolean | null>;

export type SkillAnalyticsIdentity =
  | { skill_source: "builtin"; skill_id: string }
  | { skill_source: "organization" | "local" };
export type ConnectorAnalyticsIdentity =
  | { connector_kind: "catalog"; connector_id: string }
  | { connector_kind: "custom" };
export type FeatureFileType = "browser" | "markdown" | "code" | "sheet" | "slides" | "document" | "image" | "pdf" | "html" | "text" | "external";
type ModelIdentity = { providerID: string; modelID: string };

export function nativeSkillAnalyticsIdentity(id: unknown): SkillAnalyticsIdentity {
  return { skill_source: typeof id === "string" && id.startsWith("openwork-cloud-") ? "organization" : "local" };
}
type Capture = (event: string, properties?: AnalyticsProperties) => void;

function skillProperties(identity: SkillAnalyticsIdentity): AnalyticsProperties {
  return identity.skill_source === "builtin"
    ? { skill_source: "builtin", skill_id: identity.skill_id }
    : { skill_source: identity.skill_source };
}
function connectorProperties(identity: ConnectorAnalyticsIdentity): AnalyticsProperties {
  return identity.connector_kind === "catalog"
    ? { connector_kind: "catalog", connector_id: identity.connector_id }
    : { connector_kind: identity.connector_kind };
}


export function createFeatureAnalytics(capture: Capture) {
  return {
    skillInvoked: (identity: SkillAnalyticsIdentity) => capture("skill_invoked", skillProperties(identity)),
    skillCreated: (identity: SkillAnalyticsIdentity) => capture("skill_created", skillProperties(identity)),
    skillInstalled: (identity: SkillAnalyticsIdentity) => capture("skill_installed", skillProperties(identity)),
    connectionAdded: (identity: ConnectorAnalyticsIdentity) => capture("connection_added", connectorProperties(identity)),
    connectionSignInSucceeded: (identity: ConnectorAnalyticsIdentity) => capture("connection_sign_in_succeeded", connectorProperties(identity)),
    connectionSignInFailed: (identity: ConnectorAnalyticsIdentity) => capture("connection_sign_in_failed", connectorProperties(identity)),
    connectorToolCalled: () => capture("connector_tool_called", { tool_category: "connector" }),
    automationProposed: () => capture("automation_proposed", {}),
    automationCreated: (placement: "desktop" | "cloud") => capture("automation_created", { placement }),
    automationRunStarted: (placement: "desktop" | "cloud") => capture("automation_run_started", { placement }),
    automationRunFinished: (placement: "desktop" | "cloud", outcome: "succeeded" | "failed" | "cancelled") => capture("automation_run_finished", { placement, outcome }),
    artifactCreated: () => capture("artifact_created", {}),
    artifactOpened: () => capture("artifact_opened", {}),
    browserOpened: () => capture("browser_opened", {}),
    browserUsed: () => capture("browser_used", { tool_category: "browser" }),
    computerOpened: () => capture("computer_opened", {}),
    computerUsed: () => capture("computer_used", { tool_category: "computer" }),
    filePreviewed: (fileType: FeatureFileType) => capture("file_previewed", { file_type: fileType }),
    fileEdited: (fileType: FeatureFileType) => capture("file_edited", { file_type: fileType }),
    fileDownloaded: () => capture("file_downloaded", {}),
    modelChanged: (previous: ModelIdentity | null, next: ModelIdentity, midSession: boolean) => {
      if (previous?.providerID === next.providerID && previous.modelID === next.modelID) return;
      capture("model_changed", {
        from_provider_id: previous?.providerID ?? null, from_model_id: previous?.modelID ?? null,
        to_provider_id: next.providerID, to_model_id: next.modelID, mid_session: midSession,
      });
    },
    providerConnected: (providerId: string, method: "api_key" | "oauth" | "organization") => capture("provider_connected", { provider_id: providerId, method }),
    subagentStarted: (background: boolean) => capture("subagent_started", { tool_category: "subagent", background }),
  };
}
export type FeatureAnalytics = ReturnType<typeof createFeatureAnalytics>;

export function recordDesktopAutomationLifecycle(analytics: FeatureAnalytics, event: unknown) {
  if (!event || typeof event !== "object" || !("phase" in event)) return;
  if (event.phase === "started") analytics.automationRunStarted("desktop");
  if (event.phase !== "finished" || !("outcome" in event)) return;
  if (event.outcome === "succeeded" || event.outcome === "failed" || event.outcome === "cancelled") {
    analytics.automationRunFinished("desktop", event.outcome);
  }
}
