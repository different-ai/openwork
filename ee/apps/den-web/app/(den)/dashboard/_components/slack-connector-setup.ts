import type { ConnectionReadiness } from "./mcp-connections-data";
import type { SetupCheckStatus } from "./setup-checks";

/** Where admins create and manage Slack apps. */
export const SLACK_APPS_URL = "https://api.slack.com/apps";

export function isSlackMcpUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "mcp.slack.com";
  } catch {
    return false;
  }
}

export type SlackUserOAuthManifest = {
  display_information: { name: string; description: string };
  oauth_config: { redirect_urls: string[]; scopes: { user: string[] } };
  settings: {
    is_mcp_enabled: true;
    org_deploy_enabled: false;
    socket_mode_enabled: false;
    token_rotation_enabled: false;
  };
};

/**
 * The Slack app each member signs in through: user OAuth only, OpenWork's
 * redirect URL, the user scopes the connector asks for, and Slack's MCP
 * switch (`settings.is_mcp_enabled`) on. No bot pieces: the optional
 * @openwork assistant adds those later from its own section.
 */
export function slackUserOAuthManifest(input: { redirectUrl: string; scopes: readonly string[] }): SlackUserOAuthManifest {
  return {
    display_information: {
      name: "OpenWork",
      description: "Lets OpenWork use Slack as each person who signs in.",
    },
    oauth_config: {
      redirect_urls: [input.redirectUrl],
      scopes: { user: [...new Set(input.scopes)] },
    },
    settings: {
      is_mcp_enabled: true,
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** Slack's documented share link: opens "Create an app" with this manifest filled in. */
export function slackCreateAppUrl(manifest: SlackUserOAuthManifest): string {
  return `${SLACK_APPS_URL}?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

/**
 * What OpenWork may do in Slack, chosen explicitly by the admin before any
 * Slack app manifest or connection exists. Nothing is preselected.
 */
export type SlackScopeChoice = "read_and_act" | "read_only";

type SlackPresetScopes = { defaultOAuthScopes?: readonly string[]; optionalOAuthScopes?: readonly string[] };

/**
 * The user scopes for a choice: "Read and act" is everything Slack's MCP
 * server offers (the preset's default plus its optional scopes); "Read only"
 * is the same set without any `:write` scope. No choice, no scopes.
 */
export function slackScopesFor(choice: SlackScopeChoice | null, preset: SlackPresetScopes | null | undefined): string[] {
  if (!choice) return [];
  const all = [...new Set([...(preset?.defaultOAuthScopes ?? []), ...(preset?.optionalOAuthScopes ?? [])])];
  return choice === "read_and_act" ? all : all.filter((scope) => !scope.endsWith(":write"));
}

/**
 * The setup target with the admin's explicit choice saved as the scopes the
 * new connection requests. Without a choice (or without the guided preset's
 * optional list) the target is unchanged, so only the preset's minimum applies.
 */
export function withSlackScopeChoice<T extends { preset?: SlackPresetScopes | null; requestedScopes?: readonly string[] }>(
  target: T | null,
  choice: SlackScopeChoice | null,
): T | null {
  if (!target || !choice || !target.preset?.optionalOAuthScopes?.length) return target;
  return { ...target, requestedScopes: slackScopesFor(choice, target.preset) };
}

/** What Den knows about the optional @openwork assistant for this connection. */
export type SlackAssistantStatus = "hidden" | "waiting" | "unavailable" | "installed";

export type SlackSetupInput = {
  /** The redirect URL to register; null when this deployment has no public API address. */
  callbackUrl: string | null;
  /** The admin's choice; null until they pick one. */
  scopeChoice: SlackScopeChoice | null;
  /** The scopes for that choice, which the manifest and the new connection both use. */
  scopes: readonly string[];
  /** Scopes saved on the connection once it exists. */
  savedScopeCount: number | null;
  /** The client ID (and secret) are saved on the connection. */
  appSaved: boolean;
  /** The admin marked Agents › MCP as on. Den can't see it before someone signs in. */
  mcpConfirmed: boolean;
  signedIn: boolean;
  signingIn: boolean;
  signInError: string | null;
  /** The Slack account the admin signed in as, when known. */
  accountLabel: string | null;
  /** The admin's own recorded check after signing in. Null: not checked yet. */
  readiness: Pick<ConnectionReadiness, "status" | "failure" | "reason"> | null;
  /** A check is running right now. */
  checking: boolean;
  assistant: SlackAssistantStatus;
};

export type SlackSetupStepId = "slack-access" | "slack-app" | "slack-mcp" | "sign-in-method" | "sign-in" | "slack-assistant";

export type SlackSetupStep = {
  id: SlackSetupStepId;
  title: string;
  description: string;
  status: SetupCheckStatus;
  /** Optional steps never hold up adding Slack and are not counted. */
  optional?: boolean;
  /** What the step offers right now; the screen turns these into controls. */
  offers: SlackSetupOffer[];
};

export type SlackSetupOffer =
  | "scope-choice"
  | "create-app"
  | "existing-app-details"
  | "open-slack-apps"
  | "confirm-mcp"
  | "oauth-app-fields"
  | "sign-in"
  | "sign-in-again"
  | "check-again";

/** Slack answered sign-in but refused MCP: what Slack does when the app's Agents › MCP switch is off. */
export function slackMcpRefused(readiness: SlackSetupInput["readiness"]): boolean {
  return readiness?.status === "could_not_verify" && readiness.failure === "tools_unreadable";
}

/**
 * The guided Slack checklist, in the order an admin does it. Each step shows
 * what Den actually knows: the app and its MCP switch can't be seen until
 * someone signs in, so they say "not checked yet" until the first check, then
 * show its real result.
 */
export function slackSetupSteps(input: SlackSetupInput): SlackSetupStep[] {
  const { readiness } = input;
  const ready = input.signedIn && readiness?.status === "ready";
  const mcpRefused = input.signedIn && slackMcpRefused(readiness);
  const checkPending = input.signedIn && (input.checking || !readiness);
  const chosen = input.scopeChoice !== null;

  const access: SlackSetupStep = input.appSaved
    ? {
      id: "slack-access",
      title: "Access chosen",
      description: `${input.savedScopeCount ?? 0} Slack scopes saved. Change them in the connector's settings.`,
      status: "done",
      offers: [],
    }
    : chosen
    ? {
      id: "slack-access",
      title: input.scopeChoice === "read_and_act" ? "Reads and acts in Slack" : "Reads Slack only",
      description: `${input.scopes.length} user scopes.`,
      status: "done",
      offers: ["scope-choice"],
    }
    : { id: "slack-access", title: "Choose what OpenWork can do in Slack", description: "Not chosen yet.", status: "current", offers: ["scope-choice"] };

  const app: SlackSetupStep = input.callbackUrl === null && !input.appSaved
    ? {
      id: "slack-app",
      title: "Create the Slack app",
      description: "This OpenWork has no public API address for Slack to return to. Whoever runs OpenWork can set one.",
      status: "blocked",
      offers: [],
    }
    : input.appSaved
    ? { id: "slack-app", title: "Slack app created", description: "Its client ID is saved.", status: "done", offers: [] }
    : !chosen
    ? { id: "slack-app", title: "Create the Slack app", description: "Waits for your choice above.", status: "waiting", offers: [] }
    : {
      id: "slack-app",
      title: "Create the Slack app",
      description: `Redirect URL, ${input.scopes.length} user scopes and MCP filled in.`,
      status: "current",
      offers: ["create-app", "existing-app-details"],
    };

  const mcp: SlackSetupStep = ready
    ? { id: "slack-mcp", title: "Agents › MCP is on", description: "Slack answered OpenWork's MCP requests.", status: "done", offers: [] }
    : mcpRefused
    ? {
      id: "slack-mcp",
      title: "Turn on Agents › MCP",
      description: "Slack refused MCP requests. Turn it on in your Slack app, then check again.",
      status: "failed",
      offers: ["open-slack-apps", "check-again"],
    }
    : input.mcpConfirmed
    ? {
      id: "slack-mcp",
      title: "Agents › MCP is on",
      description: checkPending ? "Checking with Slack now." : "Not checked yet. Signing in checks it.",
      status: checkPending ? "running" : "done",
      offers: [],
    }
    : {
      id: "slack-mcp",
      title: "Turn on Agents › MCP",
      description: "Not checked yet.",
      status: "current",
      offers: ["open-slack-apps", "confirm-mcp"],
    };

  const credentials: SlackSetupStep = input.appSaved
    ? { id: "sign-in-method", title: "Client ID and secret added", description: "Saved.", status: "done", offers: [] }
    : !chosen
    ? { id: "sign-in-method", title: "Add the client ID and secret", description: "Waits for your choice above.", status: "waiting", offers: [] }
    : {
      id: "sign-in-method",
      title: "Add the client ID and secret",
      description: "From Basic Information › App Credentials in Slack.",
      status: app.status === "blocked" ? "waiting" : "current",
      offers: app.status === "blocked" ? [] : ["oauth-app-fields"],
    };

  const canSignIn = input.appSaved && (input.mcpConfirmed || readiness !== null) && !input.signingIn;
  const account = input.accountLabel ? `As ${input.accountLabel}.` : "You are signed in.";
  const signIn: SlackSetupStep = (() => {
    if (!input.signedIn) {
      if (input.signInError) return { id: "sign-in", title: "Sign in with Slack to test", description: input.signInError, status: "failed", offers: canSignIn ? ["sign-in"] : [] };
      if (input.signingIn) return { id: "sign-in", title: "Sign in with Slack to test", description: "Slack opened in a new tab. Come back here when you are done.", status: "running", offers: [] };
      if (canSignIn) return { id: "sign-in", title: "Sign in with Slack to test", description: "Not signed in yet.", status: "current", offers: ["sign-in"] };
      return { id: "sign-in", title: "Sign in with Slack to test", description: "Waits for the steps above.", status: "waiting", offers: [] };
    }
    if (checkPending) return { id: "sign-in", title: "Signed in to Slack", description: `${account} Checking with Slack now.`, status: "running", offers: [] };
    if (ready) return { id: "sign-in", title: "Signed in to Slack", description: `${account} Ready.`, status: "done", offers: [] };
    if (mcpRefused) return { id: "sign-in", title: "Signed in to Slack", description: `${account} Waits for Agents › MCP.`, status: "blocked", offers: [] };
    if (readiness?.failure === "sign_in_rejected") {
      return { id: "sign-in", title: "Sign in with Slack to test", description: "Slack rejected the sign-in. Sign in again.", status: "failed", offers: ["sign-in-again"] };
    }
    return {
      id: "sign-in",
      title: "Signed in to Slack",
      description: readiness?.reason ?? "The check didn't pass. Check again.",
      status: "failed",
      offers: ["check-again"],
    };
  })();

  const steps = [access, app, mcp, credentials, signIn];
  if (input.assistant === "hidden") return steps;
  const assistant: SlackSetupStep = input.assistant === "installed"
    ? { id: "slack-assistant", title: "@openwork added to Slack", description: "Optional.", status: "done", optional: true, offers: [] }
    : input.assistant === "unavailable"
    ? {
      id: "slack-assistant",
      title: "Add @openwork to Slack",
      description: "Not available on this OpenWork. Whoever runs it can turn on the Slack assistant.",
      status: "blocked",
      optional: true,
      offers: [],
    }
    : { id: "slack-assistant", title: "Add @openwork to Slack", description: "Optional. Set it up after you add Slack.", status: "waiting", optional: true, offers: [] };
  return [...steps, assistant];
}

/** "Step 2 of 4": the first required step not done yet. */
export function slackSetupProgress(steps: readonly SlackSetupStep[]): { step: number; total: number; done: boolean } {
  const required = steps.filter((step) => !step.optional);
  const index = required.findIndex((step) => step.status !== "done");
  return { step: index === -1 ? required.length : index + 1, total: required.length, done: index === -1 };
}

/** The assistant step from the setup read: shown only for an eligible connection. */
export function slackAssistantStatus(setup: { eligible: boolean; runnerAvailable: boolean; installed: boolean } | null | undefined): SlackAssistantStatus {
  if (!setup?.eligible) return "hidden";
  if (setup.installed) return "installed";
  return setup.runnerAvailable ? "waiting" : "unavailable";
}
