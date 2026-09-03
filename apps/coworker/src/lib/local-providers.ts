/**
 * Local mode: the rules behind the "AI on this Mac" screen — what to list under
 * Found on this Mac, what counts as connected, the free model row, which
 * providers Add another offers, the connect state machine, and the plain
 * words every line uses. Pure; exercised by `local-providers.test.ts`.
 */
import type {
  EngineProviderSummary,
  LocalProviderConnectResult,
  LocalProviderFinding,
  LocalProvidersReadiness,
  ProviderSignInStart,
  ProviderSignInStatus,
} from "./bridge";
import { FREE_PROVIDER_ID, type EngineModelCatalog, type EngineModelOption } from "./threads.ts";

/** Everything a person reads on the local mode screen, in plain words. */
export const LOCAL_MODE_COPY = {
  recommended: "Continue with OpenWork for your organization's models and tools.",
  recommendedAction: "Continue with OpenWork",
  found: "Found on this Mac",
  nothingFound: "Nothing to connect was found on this Mac. The free model is ready, or add something below.",
  waitingService: "AI is starting up…",
  connected: "Connected",
  freeTitle: "A free model is ready now",
  freeDetail: (name: string) => (name ? `${name}. No setup, no account; coworkers start here until you connect something.` : "No setup, no account; coworkers start here until you connect something."),
  freeUnavailable: "The free model is not reachable right now. Check your connection, then Refresh.",
  addAnother: "Add another",
  choose: "Choose…",
  addAnotherDetail: "A provider you pay for, a key you already have, or a server you run.",
  custom: "Custom (OpenAI-compatible)",
  customDetail: "Any server that answers like OpenAI: a name, its address, and a key if it needs one.",
  connect: "Connect",
  connecting: "Connecting…",
  disconnect: "Disconnect",
  disconnectAnyway: "Disconnect anyway",
  keep: "Keep",
  refresh: "Refresh",
  openBrowser: "Open browser",
  finished: "I've finished",
  cancel: "Cancel",
  signIn: "Sign in",
  addKey: "Add key",
  save: "Save",
  back: "Back",
  waitingBrowser: "Finish signing in in your browser; this line updates by itself.",
  waitingCode: (code: string) => `Enter the code ${code} in your browser; this line updates by itself.`,
  connectedLine: (count: number) => `Connected. ${count} model${count === 1 ? "" : "s"} available.`,
  shared: "Sign-ins and keys are shared with OpenWork Desktop and OpenCode on this Mac.",
  keyPlaceholder: "Paste the key",
  keyHint: (envName: string) => (envName ? `The key you use as ${envName}.` : "The key from your provider's dashboard."),
  customName: "Name",
  customAddress: "Address",
  customKey: "Key (optional)",
  customCheck: "Check",
  customStart: "Start with",
  customListed: (count: number) => `${count} model${count === 1 ? "" : "s"} answered.`,
  useInstead: "Use a key instead",
  technicalDetails: "Technical details",
} as const;

/** Words that belong under Technical details, never in a sentence a person reads. */
export const BANNED_WORDS: ReadonlyArray<{ word: string; pattern: RegExp }> = [
  { word: "engine", pattern: /\bengines?\b/i },
  { word: "provider id", pattern: /\bprovider[ -]?id\b/i },
  { word: "auth.json", pattern: /\bauth\.json\b/i },
  { word: "OAuth", pattern: /\boauth\b/i },
  { word: "base URL", pattern: /\bbase ?url\b/i },
  { word: "SDK", pattern: /\bsdks?\b/i },
];

/** The first banned word a visible sentence uses, or null when it reads plainly. */
export function bannedWordIn(text: string): string | null {
  return BANNED_WORDS.find((entry) => entry.pattern.test(text))?.word ?? null;
}

/** The providers Add another offers by name; everything else goes through Custom. */
export const WELL_KNOWN_PROVIDERS: ReadonlyArray<{ id: string; label: string; signInOnly?: true }> = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "github-copilot", label: "GitHub Copilot", signInOnly: true },
  { id: "xai", label: "xAI" },
  { id: "mistral", label: "Mistral" },
  { id: "groq", label: "Groq" },
  { id: "deepseek", label: "DeepSeek" },
];

export type AddableProvider = {
  id: string;
  label: string;
  /** The key's usual name, for the one-line hint. */
  envName: string;
  /** The AI service can sign this provider in with a browser or device code. */
  canSignIn: boolean;
  /** A pasted key works for this provider; a subscription-only provider signs in instead. */
  acceptsKey: boolean;
  connected: boolean;
};

export type ConnectedRow = {
  providerId: string;
  label: string;
  modelCount: number;
  /** One line: where it comes from. */
  detail: string;
  canDisconnect: boolean;
};

export type LocalModePlan = {
  found: LocalProviderFinding[];
  connected: ConnectedRow[];
  free: { available: boolean; modelLabel: string };
  addable: AddableProvider[];
};

function connectedDetail(provider: EngineProviderSummary, findings: LocalProviderFinding[]): string {
  const envFinding = findings.find((finding) => finding.kind === "env" && finding.providerId === provider.id);
  if (provider.source === "env" && envFinding?.envName) return `From ${envFinding.envName} in your environment.`;
  if (provider.source === "env") return "From a key in your environment.";
  if (provider.source === "config") return "A server you added here.";
  const imported = findings.find((finding) => finding.providerId === provider.id && finding.kind !== "env" && finding.kind !== "opencode");
  if (imported?.kind === "codex") return "Your ChatGPT subscription, signed in with Codex.";
  if (imported?.kind === "copilot") return "Your Copilot subscription.";
  return "Signed in or saved on this Mac; shared with OpenWork Desktop.";
}

/**
 * What the local mode screen shows. A finding whose provider is already
 * connected moves out of Found (it is under Connected instead); the free
 * provider is its own row; account providers are left to the OpenWork Cloud
 * group above.
 */
export function planLocalMode(input: {
  findings: LocalProviderFinding[];
  readiness: Pick<LocalProvidersReadiness, "providers" | "signIns">;
  catalog: Pick<EngineModelCatalog, "models">;
}): LocalModePlan {
  const connectedIds = new Set(input.readiness.providers.filter((provider) => provider.connected).map((provider) => provider.id));
  const localModels = input.catalog.models.filter((model) => model.source === "local");
  const found = input.findings.filter((finding) => !connectedIds.has(finding.providerId) || finding.how === "unavailable");
  const connected = input.readiness.providers
    .filter((provider) => provider.connected && provider.id !== FREE_PROVIDER_ID && localModels.some((model) => model.providerId === provider.id))
    .map((provider) => ({
      providerId: provider.id,
      label: provider.name,
      modelCount: localModels.filter((model) => model.providerId === provider.id).length,
      detail: connectedDetail(provider, input.findings),
      canDisconnect: provider.source !== "env",
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const freeModel = pickFreeModel(input.catalog);
  const addable = WELL_KNOWN_PROVIDERS.flatMap((known) => {
    const provider = input.readiness.providers.find((entry) => entry.id === known.id);
    if (!provider) return [];
    const canSignIn = (input.readiness.signIns[known.id]?.length ?? 0) > 0;
    // A sign-in-only provider that the AI service cannot sign in has nothing to offer.
    if (known.signInOnly && !canSignIn) return [];
    return [{
      id: known.id,
      label: known.label,
      envName: provider.env[0] ?? "",
      canSignIn,
      acceptsKey: !known.signInOnly,
      connected: provider.connected,
    }];
  });
  return {
    found,
    connected,
    free: { available: freeModel !== null, modelLabel: freeModel?.modelLabel ?? "" },
    addable,
  };
}

/** The free model a coworker starts on: the free provider's default, else its newest tool-capable model. */
export function pickFreeModel(catalog: Pick<EngineModelCatalog, "models">): EngineModelOption | null {
  const free = catalog.models.filter((model) => model.providerId === FREE_PROVIDER_ID && model.toolCall && model.status !== "deprecated");
  return [...free].sort((left, right) =>
    Number(right.isProviderDefault) - Number(left.isProviderDefault) || right.releaseDate.localeCompare(left.releaseDate),
  )[0] ?? null;
}

/**
 * One row's connect state. Import and add flows finish in one call; a sign-in
 * flow opens the browser (or shows a device code) and waits for the AI
 * service to report the result.
 */
export type ConnectState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "connected"; line: string }
  | { phase: "failed"; error: string; canSignIn: boolean }
  | { phase: "waiting"; attemptId: string; url: string; code: string; line: string };

export type ConnectEvent =
  | { type: "connect" }
  | { type: "result"; result: LocalProviderConnectResult }
  | { type: "error"; error: string; canSignIn?: boolean }
  | { type: "sign-in-started"; start: ProviderSignInStart }
  | { type: "sign-in-status"; status: ProviderSignInStatus }
  | { type: "cancel" }
  | { type: "reset" };

export const IDLE: ConnectState = { phase: "idle" };

export function connectReducer(state: ConnectState, event: ConnectEvent): ConnectState {
  switch (event.type) {
    case "connect":
      return { phase: "connecting" };
    case "result":
      return event.result.status === "connected"
        ? { phase: "connected", line: LOCAL_MODE_COPY.connectedLine(event.result.modelCount) }
        : { phase: "failed", error: event.result.error, canSignIn: event.result.fallback === "sign-in" };
    case "error":
      return { phase: "failed", error: event.error, canSignIn: event.canSignIn === true };
    case "sign-in-started":
      return {
        phase: "waiting",
        attemptId: event.start.attemptId,
        url: event.start.url,
        code: event.start.code,
        line: event.start.code ? LOCAL_MODE_COPY.waitingCode(event.start.code) : LOCAL_MODE_COPY.waitingBrowser,
      };
    case "sign-in-status":
      if (state.phase !== "waiting") return state;
      if (event.status.state === "connected") return { phase: "connected", line: LOCAL_MODE_COPY.connectedLine(event.status.modelCount) };
      if (event.status.state === "failed") return { phase: "failed", error: event.status.error, canSignIn: true };
      return state;
    case "cancel":
    case "reset":
      return IDLE;
  }
}

/** The provider ids whose rows are busy, so a Refresh never wipes a sign-in in progress. */
export function busyProviderIds(states: Record<string, ConnectState>): string[] {
  return Object.entries(states)
    .filter(([, state]) => state.phase === "connecting" || state.phase === "waiting")
    .map(([id]) => id);
}
