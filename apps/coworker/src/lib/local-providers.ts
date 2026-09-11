/**
 * Local mode: the rules behind the "AI on this Mac" screen — what to list under
 * Found on this Mac, what counts as connected, OpenWork's free model row, which
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
import { OPENCODE_PROVIDER_ID, OPENWORK_FREE_MODEL_ID, OPENWORK_FREE_MODEL_LABEL, OPENWORK_FREE_PROVIDER_ID, type EngineModelCatalog, type EngineModelOption } from "./threads.ts";
import { chatgptEvidence } from "./model-growth.ts";

/** Everything a person reads on the local mode screen, in plain words. */
export const LOCAL_MODE_COPY = {
  found: "Found on this Mac",
  nothingFound: "Nothing to connect was found on this Mac. Sign in to OpenWork for its models, or add something below.",
  waitingService: "AI is starting up…",
  connected: "Connected",
  freeTitle: "OpenWork's free model",
  freeDetail: (name: string) => `${name}. Free from OpenWork, no account needed; coworkers start here until you connect something.`,
  freeUnavailable: (name: string) => `${name} is not available yet. Once released, coworkers without an account start here for free. Until then, sign in to OpenWork or connect your own AI.`,
  freeComingSoon: "Coming soon",
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
  connectedLine: (count: number) => count > 0 ? `Connected. ${count} model${count === 1 ? "" : "s"} available.` : "Saved on this Mac, but no models are available yet.",
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
  /** OpenWork's free model: `available` once the engine reports its provider; the label names it either way. */
  free: { available: boolean; modelLabel: string };
  addable: AddableProvider[];
};

function connectedDetail(provider: EngineProviderSummary, findings: LocalProviderFinding[]): string {
  const envFinding = findings.find((finding) => finding.kind === "env" && finding.providerId === provider.id);
  if (provider.source === "env" && envFinding?.envName) return `From ${envFinding.envName} in your environment.`;
  if (provider.source === "env") return "From a key in your environment.";
  if (provider.source === "config") return "A server you added here.";
  if (provider.id === "openai") {
    if (chatgptEvidence(findings, { providers: [provider] }).kind === "connected") return "ChatGPT sign-in on this Mac; shared with OpenWork Desktop and OpenCode.";
    if (provider.source === "api" || findings.some((finding) => finding.kind === "opencode" && finding.providerId === "openai" && finding.credentialKind === "api-key")) {
      return "An OpenAI API key saved on this Mac; shared with OpenWork Desktop and OpenCode.";
    }
    return "Signed in or saved on this Mac; shared with OpenWork Desktop.";
  }
  if (provider.source === "api") return "An API key saved on this Mac; shared with OpenWork Desktop.";
  const imported = findings.find((finding) => finding.providerId === provider.id && finding.kind !== "env" && finding.kind !== "opencode");
  if (imported?.kind === "copilot") return "Your Copilot subscription.";
  return "Signed in or saved on this Mac; shared with OpenWork Desktop.";
}

/**
 * What the local mode screen shows. A finding whose provider is already
 * connected moves out of Found, except a ChatGPT sign-in not used by that
 * connection. OpenWork's free model is its own row; OpenCode's own catalog
 * gets no row (it stays in the model picker, unpromoted); account providers
 * are left to the OpenWork Cloud group above.
 */
export function planLocalMode(input: {
  findings: LocalProviderFinding[];
  readiness: Pick<LocalProvidersReadiness, "providers" | "signIns">;
  catalog: Pick<EngineModelCatalog, "models">;
}): LocalModePlan {
  const connectedIds = new Set(input.readiness.providers.filter((provider) => provider.connected).map((provider) => provider.id));
  const localModels = input.catalog.models.filter((model) => model.source === "local");
  const chatgpt = chatgptEvidence(input.findings, input.readiness);
  const found = input.findings.filter((finding) => !connectedIds.has(finding.providerId) || finding.how === "unavailable"
    || (chatgpt.kind === "detected" && finding.id === chatgpt.findingId));
  const connected = input.readiness.providers
    .filter((provider) => provider.connected && provider.id !== OPENCODE_PROVIDER_ID && provider.id !== OPENWORK_FREE_PROVIDER_ID
      && localModels.some((model) => model.providerId === provider.id))
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
    free: { available: freeModel !== null, modelLabel: freeModel?.modelLabel ?? OPENWORK_FREE_MODEL_LABEL },
    addable,
  };
}

export type OpenAiSetupGuard = { kind: "environment" | "disconnect" | "confirm"; note: string };

/** Keep setup from importing over a shared OpenAI connection, including a saved key with no models. */
export function openAiSetupGuard(
  findings: readonly LocalProviderFinding[],
  readiness: Pick<LocalProvidersReadiness, "providers">,
): OpenAiSetupGuard | null {
  const provider = readiness.providers.find((entry) => entry.id === "openai" && entry.connected);
  if (provider?.source === "env" || (!provider && findings.some((finding) => finding.providerId === "openai" && finding.kind === "env"))) {
    return { kind: "environment", note: "OpenAI uses a key from your environment. Remove it there and restart Open Coworker before choosing another sign-in or key. Nothing is replaced here." };
  }
  if (provider) {
    return { kind: "disconnect", note: "OpenAI already has a connection. To replace its key or sign-in, disconnect it first and confirm. This also affects OpenWork Desktop and OpenCode on this Mac." };
  }
  if (findings.some((finding) => finding.kind === "opencode" && finding.providerId === "openai")) {
    return { kind: "confirm", note: "Continuing can replace the OpenAI key or sign-in saved on this Mac, including in OpenWork Desktop and OpenCode. Keep it unless you want to replace it." };
  }
  return null;
}

/**
 * OpenWork's free model, once the engine reports its provider: the standard
 * free model first, else that provider's default, else its newest tool-capable
 * model. Null until the free service is released and connected.
 */
export function pickFreeModel(catalog: Pick<EngineModelCatalog, "models">): EngineModelOption | null {
  const free = catalog.models.filter((model) => model.providerId === OPENWORK_FREE_PROVIDER_ID && model.toolCall && model.status !== "deprecated");
  return [...free].sort((left, right) =>
    Number(right.modelId === OPENWORK_FREE_MODEL_ID) - Number(left.modelId === OPENWORK_FREE_MODEL_ID)
    || Number(right.isProviderDefault) - Number(left.isProviderDefault)
    || right.releaseDate.localeCompare(left.releaseDate),
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
