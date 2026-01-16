import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import type {
  Message,
  Part,
  PermissionRequest as ApiPermissionRequest,
  Session,
} from "@opencode-ai/sdk/v2/client";

import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  Command,
  FileText,
  HardDrive,
  Play,
  Plus,
  Settings,
  Shield,
  Trash2,
  X,
  Zap,
  Link2,
  Unlink,
} from "lucide-solid";

import Button from "./components/Button";
import OpenWorkLogo from "./components/OpenWorkLogo";
import PartView from "./components/PartView";
import TextInput from "./components/TextInput";
import { createClient, unwrap, waitForHealthy } from "./lib/opencode";

type Client = ReturnType<typeof createClient>;

type MessageWithParts = {
  info: Message;
  parts: Part[];
};

type OpencodeEvent = {
  type: string;
  properties?: unknown;
};

type View = "connect" | "dashboard" | "session";

type DashboardTab = "home" | "sessions" | "templates" | "settings";

type Template = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  createdAt: number;
};

type PendingPermission = ApiPermissionRequest & {
  receivedAt: number;
};

type ModelRef = {
  providerID: string;
  modelID: string;
};

type ModelOption = ModelRef & {
  label: string;
  description: string;
  recommended?: boolean;
};

const MODEL_PREF_KEY = "openwork.ext.defaultModel";
const ZEN_PROVIDER_ID = "opencode";
const ZEN_PROVIDER_LABEL = "Zen";

const DEFAULT_MODEL: ModelRef = {
  providerID: ZEN_PROVIDER_ID,
  modelID: "gpt-5-nano",
};

const ZEN_MODEL_OPTIONS: ModelOption[] = [
  {
    providerID: ZEN_PROVIDER_ID,
    modelID: "gpt-5-nano",
    label: "Zen · GPT-5 Nano",
    description: "Fast, free, and works out of the box.",
    recommended: true,
  },
  {
    providerID: ZEN_PROVIDER_ID,
    modelID: "big-pickle",
    label: "Zen · Big Pickle",
    description: "Free Zen model.",
  },
  {
    providerID: ZEN_PROVIDER_ID,
    modelID: "glm-4.7-free",
    label: "Zen · GLM 4.7 Free",
    description: "Free Zen model.",
  },
  {
    providerID: ZEN_PROVIDER_ID,
    modelID: "grok-code",
    label: "Zen · Grok Code",
    description: "Free Zen model.",
  },
  {
    providerID: ZEN_PROVIDER_ID,
    modelID: "minimax-m2.1-free",
    label: "Zen · MiniMax M2.1 Free",
    description: "Free Zen model.",
  },
];

function formatModelRef(model: ModelRef) {
  return `${model.providerID}/${model.modelID}`;
}

function parseModelRef(raw: string | null): ModelRef | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [providerID, ...rest] = trimmed.split("/");
  if (!providerID || rest.length === 0) return null;
  return { providerID, modelID: rest.join("/") };
}

function modelEquals(a: ModelRef, b: ModelRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

function formatModelLabel(model: ModelRef) {
  if (model.providerID === ZEN_PROVIDER_ID) {
    const match = ZEN_MODEL_OPTIONS.find((opt) => opt.modelID === model.modelID);
    return match?.label ?? `${ZEN_PROVIDER_LABEL} · ${model.modelID}`;
  }
  return `${model.providerID} · ${model.modelID}`;
}

function safeStringify(value: unknown) {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (val && typeof val === "object") {
          if (seen.has(val as object)) {
            return "<circular>";
          }
          seen.add(val as object);
        }

        const lowerKey = key.toLowerCase();
        if (
          lowerKey === "reasoningencryptedcontent" ||
          lowerKey.includes("api_key") ||
          lowerKey.includes("apikey") ||
          lowerKey.includes("access_token") ||
          lowerKey.includes("refresh_token") ||
          lowerKey.includes("token") ||
          lowerKey.includes("authorization") ||
          lowerKey.includes("cookie") ||
          lowerKey.includes("secret")
        ) {
          return "[redacted]";
        }

        return val;
      },
      2,
    );
  } catch {
    return "<unserializable>";
  }
}

function normalizeEvent(raw: unknown): OpencodeEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.type === "string") {
    return {
      type: record.type,
      properties: record.properties,
    };
  }

  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>;
    if (typeof payload.type === "string") {
      return {
        type: payload.type,
        properties: payload.properties,
      };
    }
  }

  return null;
}

function formatRelativeTime(timestampMs: number) {
  const delta = Date.now() - timestampMs;

  if (delta < 0) {
    return "just now";
  }

  if (delta < 60_000) {
    return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  }

  if (delta < 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  }

  if (delta < 24 * 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / (60 * 60_000)))}h ago`;
  }

  return new Date(timestampMs).toLocaleDateString();
}

function upsertSession(list: Session[], next: Session) {
  const idx = list.findIndex((s) => s.id === next.id);
  if (idx === -1) return [...list, next];

  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

function upsertMessage(list: MessageWithParts[], nextInfo: Message) {
  const idx = list.findIndex((m) => m.info.id === nextInfo.id);
  if (idx === -1) {
    return list.concat({ info: nextInfo, parts: [] });
  }

  const copy = list.slice();
  copy[idx] = { ...copy[idx], info: nextInfo };
  return copy;
}

function upsertPart(list: MessageWithParts[], nextPart: Part) {
  const msgIdx = list.findIndex((m) => m.info.id === nextPart.messageID);
  if (msgIdx === -1) {
    return list;
  }

  const copy = list.slice();
  const msg = copy[msgIdx];
  const parts = msg.parts.slice();
  const partIdx = parts.findIndex((p) => p.id === nextPart.id);

  if (partIdx === -1) {
    parts.push(nextPart);
  } else {
    parts[partIdx] = nextPart;
  }

  copy[msgIdx] = { ...msg, parts };
  return copy;
}

function removePart(list: MessageWithParts[], messageID: string, partID: string) {
  const msgIdx = list.findIndex((m) => m.info.id === messageID);
  if (msgIdx === -1) return list;

  const copy = list.slice();
  const msg = copy[msgIdx];
  copy[msgIdx] = { ...msg, parts: msg.parts.filter((p) => p.id !== partID) };
  return copy;
}

function normalizeSessionStatus(status: unknown) {
  if (!status || typeof status !== "object") return "idle";
  const record = status as Record<string, unknown>;
  if (record.type === "busy") return "running";
  if (record.type === "retry") return "retry";
  if (record.type === "idle") return "idle";
  return "idle";
}

function modelFromUserMessage(info: Message): ModelRef | null {
  if (!info || typeof info !== "object") return null;
  if ((info as any).role !== "user") return null;

  const model = (info as any).model as unknown;
  if (!model || typeof model !== "object") return null;

  const providerID = (model as any).providerID;
  const modelID = (model as any).modelID;

  if (typeof providerID !== "string" || typeof modelID !== "string") return null;
  return { providerID, modelID };
}

function lastUserModelFromMessages(list: MessageWithParts[]): ModelRef | null {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const model = modelFromUserMessage(list[i]?.info);
    if (model) return model;
  }

  return null;
}

// Storage helpers for Chrome extension
function getStorage<T>(key: string, defaultValue: T): T {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return defaultValue;
    return JSON.parse(value) as T;
  } catch {
    return defaultValue;
  }
}

function setStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export default function App() {
  const [view, setView] = createSignal<View>("connect");
  const [tab, setTab] = createSignal<DashboardTab>("home");

  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:4096");
  const [clientDirectory, setClientDirectory] = createSignal("");

  const [client, setClient] = createSignal<Client | null>(null);
  const [connectedVersion, setConnectedVersion] = createSignal<string | null>(null);
  const [sseConnected, setSseConnected] = createSignal(false);

  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const [sessionStatusById, setSessionStatusById] = createSignal<Record<string, string>>({});

  const [messages, setMessages] = createSignal<MessageWithParts[]>([]);
  const [todos, setTodos] = createSignal<
    Array<{ id: string; content: string; status: string; priority: string }>
  >([]);
  const [pendingPermissions, setPendingPermissions] = createSignal<PendingPermission[]>([]);
  const [permissionReplyBusy, setPermissionReplyBusy] = createSignal(false);

  const [prompt, setPrompt] = createSignal("");

  const [templates, setTemplates] = createSignal<Template[]>([]);
  const [templateModalOpen, setTemplateModalOpen] = createSignal(false);
  const [templateDraftTitle, setTemplateDraftTitle] = createSignal("");
  const [templateDraftDescription, setTemplateDraftDescription] = createSignal("");
  const [templateDraftPrompt, setTemplateDraftPrompt] = createSignal("");

  const [events, setEvents] = createSignal<OpencodeEvent[]>([]);
  const [developerMode, setDeveloperMode] = createSignal(false);

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<"session" | "default">("session");
  const [sessionModelOverrideById, setSessionModelOverrideById] = createSignal<Record<string, ModelRef>>({});
  const [sessionModelById, setSessionModelById] = createSignal<Record<string, ModelRef>>({});

  const [busy, setBusy] = createSignal(false);
  const [_busyLabel, setBusyLabel] = createSignal<string | null>(null);
  const [_busyStartedAt, setBusyStartedAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const headerStatus = createMemo(() => {
    const c = client();
    const version = connectedVersion();
    const sse = sseConnected();

    if (!c) return "Disconnected";
    if (sse) return `v${version}`;
    return `Connecting · v${version}`;
  });

  const selectedSession = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return null;
    return sessions().find((s) => s.id === id) ?? null;
  });

  const selectedSessionStatus = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return "idle";
    return sessionStatusById()[id] ?? "idle";
  });

  const selectedSessionModel = createMemo<ModelRef>(() => {
    const id = selectedSessionId();
    if (!id) return defaultModel();

    const override = sessionModelOverrideById()[id];
    if (override) return override;

    const known = sessionModelById()[id];
    if (known) return known;

    const fromMessages = lastUserModelFromMessages(messages());
    if (fromMessages) return fromMessages;

    return defaultModel();
  });

  const selectedSessionModelLabel = createMemo(() => formatModelLabel(selectedSessionModel()));

  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default" ? defaultModel() : selectedSessionModel(),
  );

  function openSessionModelPicker() {
    setModelPickerTarget("session");
    setModelPickerOpen(true);
  }

  function openDefaultModelPicker() {
    setModelPickerTarget("default");
    setModelPickerOpen(true);
  }

  function applyModelSelection(next: ModelRef) {
    if (modelPickerTarget() === "default") {
      setDefaultModel(next);
      setStorage(MODEL_PREF_KEY, formatModelRef(next));
      setModelPickerOpen(false);
      return;
    }

    const id = selectedSessionId();
    if (!id) {
      setModelPickerOpen(false);
      return;
    }

    setSessionModelOverrideById((current) => ({ ...current, [id]: next }));
    setModelPickerOpen(false);
  }

  const activePermission = createMemo(() => {
    const id = selectedSessionId();
    const list = pendingPermissions();

    if (id) {
      return list.find((p) => p.sessionID === id) ?? null;
    }

    return list[0] ?? null;
  });

  async function loadSessions(c: Client) {
    const list = unwrap(await c.session.list());
    setSessions(list);
  }

  async function refreshPendingPermissions(c: Client) {
    const list = unwrap(await c.permission.list());

    setPendingPermissions((current) => {
      const now = Date.now();
      const byId = new Map(current.map((p) => [p.id, p] as const));
      return list.map((p) => ({ ...p, receivedAt: byId.get(p.id)?.receivedAt ?? now }));
    });
  }

  async function connectToServer(nextBaseUrl: string, directory?: string) {
    setError(null);
    setBusy(true);
    setBusyLabel("Connecting");
    setBusyStartedAt(Date.now());
    setSseConnected(false);

    try {
      const nextClient = createClient(nextBaseUrl, directory);
      const health = await waitForHealthy(nextClient, { timeoutMs: 12_000 });

      setClient(nextClient);
      setConnectedVersion(health.version);
      setBaseUrl(nextBaseUrl);
      
      // Store in local storage
      setStorage("openwork.ext.baseUrl", nextBaseUrl);
      if (directory) {
        setStorage("openwork.ext.clientDirectory", directory);
      }

      await loadSessions(nextClient);
      await refreshPendingPermissions(nextClient);

      setSelectedSessionId(null);
      setMessages([]);
      setTodos([]);

      setView("dashboard");
      setTab("home");
      return true;
    } catch (e) {
      setClient(null);
      setConnectedVersion(null);
      setError(e instanceof Error ? e.message : safeStringify(e));
      return false;
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function disconnect() {
    setClient(null);
    setConnectedVersion(null);
    setSessions([]);
    setSelectedSessionId(null);
    setMessages([]);
    setTodos([]);
    setPendingPermissions([]);
    setSessionStatusById({});
    setSseConnected(false);
    setView("connect");
  }

  async function selectSession(sessionID: string) {
    const c = client();
    if (!c) return;

    setSelectedSessionId(sessionID);
    setError(null);

    const msgs = unwrap(await c.session.messages({ sessionID }));
    setMessages(msgs);

    const model = lastUserModelFromMessages(msgs);
    if (model) {
      setSessionModelById((current) => ({
        ...current,
        [sessionID]: model,
      }));

      setSessionModelOverrideById((current) => {
        if (!current[sessionID]) return current;
        const copy = { ...current };
        delete copy[sessionID];
        return copy;
      });
    }

    try {
      setTodos(unwrap(await c.session.todo({ sessionID })));
    } catch {
      setTodos([]);
    }

    try {
      await refreshPendingPermissions(c);
    } catch {
      // ignore
    }
  }

  async function createSessionAndOpen() {
    const c = client();
    if (!c) return;

    setBusy(true);
    setBusyLabel("Creating session");
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      const session = unwrap(await c.session.create({ title: "New task" }));
      await loadSessions(c);
      await selectSession(session.id);
      setView("session");
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function sendPrompt() {
    const c = client();
    const sessionID = selectedSessionId();
    if (!c || !sessionID) return;

    const content = prompt().trim();
    if (!content) return;

    setBusy(true);
    setBusyLabel("Running");
    setBusyStartedAt(Date.now());
    setError(null);

    try {
      setPrompt("");

      const model = selectedSessionModel();

      unwrap(
        await c.session.prompt({
          sessionID,
          model,
          parts: [{ type: "text", text: content }],
        }),
      );

      setSessionModelById((current) => ({
        ...current,
        [sessionID]: model,
      }));

      setSessionModelOverrideById((current) => {
        if (!current[sessionID]) return current;
        const copy = { ...current };
        delete copy[sessionID];
        return copy;
      });

      const msgs = unwrap(await c.session.messages({ sessionID }));
      setMessages(msgs);

      try {
        setTodos(unwrap(await c.session.todo({ sessionID })));
      } catch {
        setTodos([]);
      }

      await loadSessions(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  function saveTemplate() {
    const title = templateDraftTitle().trim();
    const promptText = templateDraftPrompt().trim();
    const description = templateDraftDescription().trim();

    if (!title || !promptText) {
      setError("Template title and prompt are required.");
      return;
    }

    const template: Template = {
      id: `tmpl_${Date.now()}`,
      title,
      description,
      prompt: promptText,
      createdAt: Date.now(),
    };

    const updated = [template, ...templates()];
    setTemplates(updated);
    setStorage("openwork.ext.templates", updated);
    setTemplateModalOpen(false);
  }

  function deleteTemplate(templateId: string) {
    const updated = templates().filter((t) => t.id !== templateId);
    setTemplates(updated);
    setStorage("openwork.ext.templates", updated);
  }

  async function runTemplate(template: Template) {
    const c = client();
    if (!c) return;

    setBusy(true);
    setError(null);

    try {
      const session = unwrap(await c.session.create({ title: template.title }));
      await loadSessions(c);
      await selectSession(session.id);
      setView("session");

      const model = defaultModel();

      unwrap(
        await c.session.prompt({
          sessionID: session.id,
          model,
          parts: [{ type: "text", text: template.prompt }],
        }),
      );

      setSessionModelById((current) => ({
        ...current,
        [session.id]: model,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function respondPermission(requestID: string, reply: "once" | "always" | "reject") {
    const c = client();
    if (!c || permissionReplyBusy()) return;

    setPermissionReplyBusy(true);
    setError(null);

    try {
      unwrap(await c.permission.reply({ requestID, reply }));
      await refreshPendingPermissions(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setPermissionReplyBusy(false);
    }
  }

  onMount(async () => {
    // Load stored preferences
    const storedBaseUrl = getStorage("openwork.ext.baseUrl", "http://127.0.0.1:4096");
    setBaseUrl(storedBaseUrl);

    const storedClientDir = getStorage("openwork.ext.clientDirectory", "");
    setClientDirectory(storedClientDir);

    const storedTemplates = getStorage<Template[]>("openwork.ext.templates", []);
    setTemplates(storedTemplates);

    const storedDefaultModel = getStorage<string | null>(MODEL_PREF_KEY, null);
    const parsedDefaultModel = parseModelRef(storedDefaultModel);
    if (parsedDefaultModel) {
      setDefaultModel(parsedDefaultModel);
    } else {
      setDefaultModel(DEFAULT_MODEL);
    }

    // Try to auto-connect if we have a stored URL
    if (storedBaseUrl) {
      try {
        await connectToServer(storedBaseUrl, storedClientDir || undefined);
      } catch {
        // Stay on connect screen
      }
    }
  });

  // SSE Effect for real-time updates
  createEffect(() => {
    const c = client();
    if (!c) return;

    const clientRef = c; // Capture non-null client reference
    let abortController = new AbortController();

    async function subscribe() {
      try {
        const result = await clientRef.event.subscribe({}, { signal: abortController.signal });
        // The SDK returns either a Response or an object with response property
        const response = 'response' in result ? result.response : result;
        const body = (response as Response).body;

        if (!body) {
          console.warn("No response body for SSE");
          return;
        }

        setSseConnected(true);

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;

            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;

            try {
              const parsed = JSON.parse(raw);
              const evt = normalizeEvent(parsed);

              if (!evt) continue;

              setEvents((prev) => [...prev.slice(-50), evt]);

              // Handle events
              if (evt.type === "session.created" || evt.type === "session.updated") {
                const props = evt.properties as { info?: Session } | undefined;
                if (props?.info) {
                  setSessions((list) => upsertSession(list, props.info!));

                  const status = normalizeSessionStatus((props.info as any).status);
                  setSessionStatusById((byId) => ({ ...byId, [props.info!.id]: status }));
                }
              }

              if (evt.type === "message.created" || evt.type === "message.updated") {
                const props = evt.properties as { info?: Message } | undefined;
                if (props?.info && props.info.sessionID === selectedSessionId()) {
                  setMessages((list) => upsertMessage(list, props.info!));
                }
              }

              if (evt.type === "message.part.created" || evt.type === "message.part.updated") {
                const props = evt.properties as { info?: Part } | undefined;
                if (props?.info) {
                  setMessages((list) => upsertPart(list, props.info!));
                }
              }

              if (evt.type === "message.part.deleted") {
                const props = evt.properties as { messageID?: string; partID?: string } | undefined;
                if (props?.messageID && props?.partID) {
                  setMessages((list) => removePart(list, props.messageID!, props.partID!));
                }
              }

              if (evt.type === "permission.created" || evt.type === "permission.updated") {
                try {
                  await refreshPendingPermissions(clientRef);
                } catch {
                  // ignore
                }
              }

              if (evt.type === "permission.deleted") {
                try {
                  await refreshPendingPermissions(clientRef);
                } catch {
                  // ignore
                }
              }

              if (evt.type === "todo.created" || evt.type === "todo.updated" || evt.type === "todo.deleted") {
                const sessionID = selectedSessionId();
                if (sessionID) {
                  try {
                    setTodos(unwrap(await clientRef.session.todo({ sessionID })));
                  } catch {
                    setTodos([]);
                  }
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          console.error("SSE error:", e);
          setSseConnected(false);
        }
      }
    }

    subscribe();

    onCleanup(() => {
      abortController.abort();
      setSseConnected(false);
    });
  });

  // Save baseUrl changes
  createEffect(() => {
    setStorage("openwork.ext.baseUrl", baseUrl());
  });

  createEffect(() => {
    setStorage("openwork.ext.clientDirectory", clientDirectory());
  });

  function ConnectView() {
    return (
      <div class="sidepanel-container flex flex-col bg-black text-white p-4">
        <div class="flex items-center gap-2 mb-6">
          <div class="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
            <OpenWorkLogo size={16} class="text-black" />
          </div>
          <span class="font-bold text-lg tracking-tight">OpenWork</span>
        </div>

        <div class="flex-1 space-y-4">
          <div class="text-center py-6 space-y-3">
            <div class="w-14 h-14 bg-zinc-900 rounded-2xl mx-auto flex items-center justify-center border border-zinc-800">
              <Link2 class="text-zinc-500" size={24} />
            </div>
            <h2 class="text-lg font-semibold">Connect to OpenCode</h2>
            <p class="text-sm text-zinc-400">
              Enter your OpenCode server URL to connect.
            </p>
          </div>

          <TextInput
            label="Server URL"
            placeholder="http://127.0.0.1:4096"
            value={baseUrl()}
            onInput={(e) => setBaseUrl(e.currentTarget.value)}
          />

          <TextInput
            label="Directory (optional)"
            placeholder="/path/to/project"
            value={clientDirectory()}
            onInput={(e) => setClientDirectory(e.currentTarget.value)}
            hint="Use if your server runs multiple workspaces."
          />

          <Button
            onClick={async () => {
              await connectToServer(
                baseUrl().trim(),
                clientDirectory().trim() || undefined,
              );
            }}
            disabled={busy() || !baseUrl().trim()}
            class="w-full py-3 text-base"
          >
            {busy() ? "Connecting..." : "Connect"}
          </Button>

          <Show when={error()}>
            <div class="rounded-xl bg-red-950/40 px-4 py-3 text-sm text-red-200 border border-red-500/20">
              {error()}
            </div>
          </Show>

          <div class="text-xs text-zinc-600 text-center mt-4">
            Start OpenCode with `opencode serve` on your machine first.
          </div>
        </div>
      </div>
    );
  }

  function DashboardView() {
    const title = createMemo(() => {
      switch (tab()) {
        case "sessions":
          return "Sessions";
        case "templates":
          return "Templates";
        case "settings":
          return "Settings";
        default:
          return "Dashboard";
      }
    });

    const quickTemplates = createMemo(() => templates().slice(0, 3));

    const navItem = (t: DashboardTab, icon: any) => {
      const active = () => tab() === t;
      return (
        <button
          class={`flex-1 flex flex-col items-center gap-1 py-2 text-xs font-medium transition-colors ${
            active() ? "text-white" : "text-zinc-500"
          }`}
          onClick={() => setTab(t)}
        >
          {icon}
        </button>
      );
    };

    const content = () => (
      <Switch>
        <Match when={tab() === "home"}>
          <section class="space-y-4">
            <div class="bg-zinc-900 rounded-2xl p-4 border border-zinc-800">
              <h2 class="text-base font-semibold text-white mb-2">What should we do?</h2>
              <p class="text-sm text-zinc-400 mb-3">
                Describe a task for OpenWork to execute.
              </p>
              <Button onClick={createSessionAndOpen} disabled={busy()} class="w-full">
                <Play size={16} />
                New Task
              </Button>
            </div>

            <Show when={quickTemplates().length > 0}>
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h3 class="text-xs font-medium text-zinc-400 uppercase">Templates</h3>
                  <button class="text-xs text-zinc-500 hover:text-white" onClick={() => setTab("templates")}>
                    All
                  </button>
                </div>
                <div class="space-y-2">
                  <For each={quickTemplates()}>
                    {(t) => (
                      <button
                        onClick={() => runTemplate(t)}
                        class="w-full p-3 rounded-xl bg-zinc-900/50 border border-zinc-800/50 hover:bg-zinc-900 text-left"
                      >
                        <div class="flex items-center gap-2">
                          <FileText size={14} class="text-indigo-400" />
                          <span class="text-sm font-medium text-white truncate">{t.title}</span>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <div>
              <h3 class="text-xs font-medium text-zinc-400 uppercase mb-2">Recent</h3>
              <div class="space-y-1">
                <For each={sessions().slice(0, 5)}>
                  {(s) => (
                    <button
                      class="w-full p-3 rounded-xl hover:bg-zinc-900/50 transition-colors text-left flex items-center justify-between"
                      onClick={async () => {
                        await selectSession(s.id);
                        setView("session");
                      }}
                    >
                      <div class="min-w-0">
                        <div class="text-sm font-medium text-zinc-200 truncate">{s.title}</div>
                        <div class="text-xs text-zinc-500 flex items-center gap-1 mt-0.5">
                          <Clock size={10} /> {formatRelativeTime(s.time.updated)}
                        </div>
                      </div>
                      <ChevronRight size={14} class="text-zinc-600 shrink-0" />
                    </button>
                  )}
                </For>
                <Show when={!sessions().length}>
                  <div class="p-4 text-sm text-zinc-500 text-center">No sessions yet.</div>
                </Show>
              </div>
            </div>
          </section>
        </Match>

        <Match when={tab() === "sessions"}>
          <section>
            <div class="space-y-1">
              <For each={sessions()}>
                {(s) => (
                  <button
                    class="w-full p-3 rounded-xl hover:bg-zinc-900/50 transition-colors text-left flex items-center justify-between"
                    onClick={async () => {
                      await selectSession(s.id);
                      setView("session");
                    }}
                  >
                    <div class="min-w-0">
                      <div class="text-sm font-medium text-zinc-200 truncate">{s.title}</div>
                      <div class="text-xs text-zinc-500 flex items-center gap-1 mt-0.5">
                        <Clock size={10} /> {formatRelativeTime(s.time.updated)}
                      </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <span class="text-xs px-1.5 py-0.5 rounded-full border border-zinc-700/60 text-zinc-400 flex items-center gap-1">
                        <span class="w-1 h-1 rounded-full bg-current" />
                        {sessionStatusById()[s.id] ?? "idle"}
                      </span>
                      <ChevronRight size={14} class="text-zinc-600" />
                    </div>
                  </button>
                )}
              </For>
              <Show when={!sessions().length}>
                <div class="p-4 text-sm text-zinc-500 text-center">No sessions yet.</div>
              </Show>
            </div>
          </section>
        </Match>

        <Match when={tab() === "templates"}>
          <section class="space-y-3">
            <div class="flex items-center justify-between">
              <h3 class="text-xs font-medium text-zinc-400 uppercase">Templates</h3>
              <Button
                variant="secondary"
                class="text-xs h-7 px-2"
                onClick={() => {
                  setTemplateDraftTitle("");
                  setTemplateDraftDescription("");
                  setTemplateDraftPrompt("");
                  setTemplateModalOpen(true);
                }}
              >
                <Plus size={12} />
                New
              </Button>
            </div>

            <Show
              when={templates().length}
              fallback={
                <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-xl p-4 text-sm text-zinc-500 text-center">
                  No templates yet.
                </div>
              }
            >
              <div class="space-y-2">
                <For each={templates()}>
                  {(t) => (
                    <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-xl p-3 flex items-start justify-between gap-2">
                      <div class="min-w-0">
                        <div class="flex items-center gap-2">
                          <FileText size={12} class="text-indigo-400 shrink-0" />
                          <div class="font-medium text-sm text-white truncate">{t.title}</div>
                        </div>
                        <div class="mt-0.5 text-xs text-zinc-500 truncate">{t.description || ""}</div>
                      </div>
                      <div class="shrink-0 flex gap-1">
                        <Button variant="secondary" class="h-7 w-7 p-0" onClick={() => runTemplate(t)}>
                          <Play size={12} />
                        </Button>
                        <Button variant="danger" class="h-7 w-7 p-0" onClick={() => deleteTemplate(t.id)}>
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </Match>

        <Match when={tab() === "settings"}>
          <section class="space-y-4">
            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-xl p-4 space-y-2">
              <div class="text-sm font-medium text-white">Connection</div>
              <div class="text-xs text-zinc-500">{headerStatus()}</div>
              <div class="text-xs text-zinc-600 font-mono truncate">{baseUrl()}</div>
              <div class="flex gap-2 pt-2">
                <Button variant="secondary" class="text-xs flex-1" onClick={() => setDeveloperMode((v) => !v)}>
                  <Shield size={12} />
                  {developerMode() ? "Dev On" : "Dev Off"}
                </Button>
                <Button variant="outline" class="text-xs flex-1" onClick={disconnect}>
                  <Unlink size={12} />
                  Disconnect
                </Button>
              </div>
            </div>

            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-xl p-4 space-y-2">
              <div class="text-sm font-medium text-white">Default Model</div>
              <div class="flex items-center justify-between bg-zinc-950 p-2 rounded-lg border border-zinc-800 gap-2">
                <div class="min-w-0">
                  <div class="text-xs text-zinc-200 truncate">{formatModelLabel(defaultModel())}</div>
                </div>
                <Button variant="outline" class="text-xs h-6 py-0 px-2 shrink-0" onClick={openDefaultModelPicker}>
                  Change
                </Button>
              </div>
            </div>

            <Show when={developerMode()}>
              <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-xl p-4 space-y-2">
                <div class="text-xs text-zinc-500">Events ({events().length})</div>
                <pre class="text-xs text-zinc-200 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                  {safeStringify(events().slice(-5))}
                </pre>
              </div>
            </Show>
          </section>
        </Match>
      </Switch>
    );

    return (
      <div class="sidepanel-container flex flex-col bg-zinc-950 text-white">
        <header class="h-12 flex items-center justify-between px-4 border-b border-zinc-800 bg-zinc-950 sticky top-0 z-10">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 bg-white rounded-md flex items-center justify-center">
              <OpenWorkLogo size={12} class="text-black" />
            </div>
            <span class="font-medium text-sm">{title()}</span>
          </div>
          <div class="flex items-center gap-1">
            <div class={`w-2 h-2 rounded-full ${sseConnected() ? "bg-emerald-500" : "bg-zinc-600"}`} />
            <span class="text-xs text-zinc-500">{headerStatus()}</span>
          </div>
        </header>

        <div class="flex-1 overflow-y-auto p-4">
          {content()}

          <Show when={error()}>
            <div class="mt-4 rounded-xl bg-red-950/40 px-4 py-3 text-sm text-red-200 border border-red-500/20">
              {error()}
            </div>
          </Show>
        </div>

        <nav class="border-t border-zinc-800 bg-zinc-950 flex">
          {navItem("home", <Command size={16} />)}
          {navItem("sessions", <Play size={16} />)}
          {navItem("templates", <FileText size={16} />)}
          {navItem("settings", <Settings size={16} />)}
        </nav>
      </div>
    );
  }

  function SessionView() {
    let messagesEndEl: HTMLDivElement | undefined;

    createEffect(() => {
      messages();
      todos();
      messagesEndEl?.scrollIntoView({ behavior: "smooth" });
    });

    return (
      <Show
        when={selectedSessionId()}
        fallback={
          <div class="sidepanel-container flex items-center justify-center bg-zinc-950 text-white p-4">
            <div class="text-center space-y-3">
              <div class="text-sm font-medium">No session selected</div>
              <Button
                onClick={() => {
                  setView("dashboard");
                  setTab("sessions");
                }}
              >
                Back
              </Button>
            </div>
          </div>
        }
      >
        <div class="sidepanel-container flex flex-col bg-zinc-950 text-white">
          <header class="h-12 border-b border-zinc-800 flex items-center justify-between px-3 bg-zinc-950 sticky top-0 z-10">
            <div class="flex items-center gap-2">
              <Button
                variant="ghost"
                class="!p-1.5 rounded-full"
                onClick={() => {
                  setView("dashboard");
                  setTab("sessions");
                }}
              >
                <ArrowRight class="rotate-180 w-4 h-4" />
              </Button>
              <div class="min-w-0">
                <h2 class="font-medium text-xs truncate">{selectedSession()?.title ?? "Session"}</h2>
                <div class="flex items-center gap-1 text-[10px] text-zinc-400">
                  <span
                    class={`w-1.5 h-1.5 rounded-full ${
                      selectedSessionStatus() === "running"
                        ? "bg-blue-500 animate-pulse"
                        : selectedSessionStatus() === "retry"
                          ? "bg-amber-500"
                          : "bg-emerald-500"
                    }`}
                  />
                  {selectedSessionStatus()}
                </div>
              </div>
            </div>

            <button
              class="flex items-center gap-1 px-2 py-1 rounded-full bg-zinc-900/60 border border-zinc-800 text-[10px] text-zinc-200"
              onClick={openSessionModelPicker}
            >
              <span class="truncate max-w-[80px]">{selectedSessionModelLabel()}</span>
              <ChevronRight size={10} class="text-zinc-500" />
            </button>
          </header>

          <div class="flex-1 overflow-y-auto p-3">
            <div class="space-y-3 pb-16">
              <Show when={messages().length === 0}>
                <div class="text-center py-10 space-y-2">
                  <div class="w-12 h-12 bg-zinc-900 rounded-2xl mx-auto flex items-center justify-center border border-zinc-800">
                    <Zap class="text-zinc-600" size={20} />
                  </div>
                  <h3 class="text-sm font-medium">Ready to work</h3>
                  <p class="text-zinc-500 text-xs max-w-[200px] mx-auto">
                    Describe a task. I'll show progress and ask for permissions.
                  </p>
                </div>
              </Show>

              <For each={messages()}>
                {(msg) => {
                  const renderableParts = () =>
                    msg.parts.filter((p) => {
                      if (p.type === "reasoning") return developerMode();
                      if (p.type === "step-start" || p.type === "step-finish") return developerMode();
                      if (p.type === "text" || p.type === "tool") return true;
                      return developerMode();
                    });

                  return (
                    <Show when={renderableParts().length > 0}>
                      <div class={`flex ${msg.info.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div
                          class={`max-w-[90%] p-3 rounded-xl text-xs leading-relaxed ${
                            msg.info.role === "user"
                              ? "bg-white text-black rounded-tr-sm"
                              : "bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-tl-sm"
                          }`}
                        >
                          <For each={renderableParts()}>
                            {(p, idx) => (
                              <div class={idx() === renderableParts().length - 1 ? "" : "mb-2"}>
                                <PartView part={p} developerMode={developerMode()} tone={msg.info.role === "user" ? "dark" : "light"} />
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                  );
                }}
              </For>

              <div ref={(el) => (messagesEndEl = el)} />
            </div>
          </div>

          <div class="p-3 border-t border-zinc-800 bg-zinc-950 sticky bottom-0 z-10">
            <div class="relative">
              <input
                type="text"
                disabled={busy()}
                value={prompt()}
                onInput={(e) => setPrompt(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    sendPrompt().catch(() => undefined);
                  }
                }}
                placeholder={busy() ? "Working..." : "Type a task..."}
                class="w-full bg-zinc-900 border border-zinc-800 rounded-xl py-2.5 pl-3 pr-10 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-600 disabled:opacity-50"
              />
              <button
                disabled={!prompt().trim() || busy()}
                onClick={() => sendPrompt().catch(() => undefined)}
                class="absolute right-1.5 top-1.5 p-1.5 bg-white text-black rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-0 disabled:scale-75"
              >
                <ArrowRight size={14} />
              </button>
            </div>
          </div>

          <Show when={activePermission()}>
            <div class="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3">
              <div class="bg-zinc-900 border border-amber-500/30 w-full max-w-sm rounded-xl shadow-2xl overflow-hidden">
                <div class="p-4">
                  <div class="flex items-start gap-3 mb-3">
                    <div class="p-2 bg-amber-500/10 rounded-full text-amber-500">
                      <Shield size={18} />
                    </div>
                    <div>
                      <h3 class="text-sm font-semibold text-white">Permission Required</h3>
                      <p class="text-xs text-zinc-400 mt-0.5">
                        OpenCode needs permission to continue.
                      </p>
                    </div>
                  </div>

                  <div class="bg-zinc-950/50 rounded-lg p-3 border border-zinc-800 mb-4">
                    <div class="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Permission</div>
                    <div class="text-xs text-zinc-200 font-mono">{activePermission()!.permission}</div>

                    <div class="text-[10px] text-zinc-500 uppercase tracking-wider mt-2 mb-1">Scope</div>
                    <div class="flex items-center gap-1 text-xs font-mono text-amber-200 bg-amber-950/30 px-2 py-1 rounded border border-amber-500/20">
                      <HardDrive size={10} />
                      {activePermission()!.patterns.join(", ")}
                    </div>
                  </div>

                  <div class="grid grid-cols-3 gap-2">
                    <Button
                      variant="outline"
                      class="text-xs border-red-500/20 text-red-400 hover:bg-red-950/30"
                      onClick={() => respondPermission(activePermission()!.id, "reject")}
                      disabled={permissionReplyBusy()}
                    >
                      Deny
                    </Button>
                    <Button
                      variant="secondary"
                      class="text-xs"
                      onClick={() => respondPermission(activePermission()!.id, "once")}
                      disabled={permissionReplyBusy()}
                    >
                      Once
                    </Button>
                    <Button
                      variant="primary"
                      class="text-xs font-bold bg-amber-500 hover:bg-amber-400 text-black border-none"
                      onClick={() => respondPermission(activePermission()!.id, "always")}
                      disabled={permissionReplyBusy()}
                    >
                      Allow
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </Show>
    );
  }

  return (
    <>
      <Show when={client()} fallback={<ConnectView />}>
        <Switch>
          <Match when={view() === "dashboard"}>
            <DashboardView />
          </Match>
          <Match when={view() === "session"}>
            <SessionView />
          </Match>
          <Match when={true}>
            <DashboardView />
          </Match>
        </Switch>
      </Show>

      <Show when={modelPickerOpen()}>
        <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3">
          <div class="bg-zinc-900 border border-zinc-800/70 w-full max-w-sm rounded-xl shadow-2xl overflow-hidden">
            <div class="p-4">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <h3 class="text-sm font-semibold text-white">
                    {modelPickerTarget() === "default" ? "Default Model" : "Model"}
                  </h3>
                  <p class="text-xs text-zinc-400 mt-0.5">
                    {modelPickerTarget() === "default" ? "Used for new sessions" : "For your next message"}
                  </p>
                </div>
                <Button variant="ghost" class="!p-1.5 rounded-full" onClick={() => setModelPickerOpen(false)}>
                  <X size={14} />
                </Button>
              </div>

              <div class="mt-4 space-y-1.5 max-h-60 overflow-y-auto">
                <For each={ZEN_MODEL_OPTIONS}>
                  {(opt) => {
                    const active = () => modelEquals(modelPickerCurrent(), opt);

                    return (
                      <button
                        class={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                          active()
                            ? "border-white/20 bg-white/5"
                            : "border-zinc-800/70 bg-zinc-950/40 hover:bg-zinc-950/60"
                        }`}
                        onClick={() => applyModelSelection(opt)}
                      >
                        <div class="flex items-start justify-between gap-2">
                          <div class="min-w-0">
                            <div class="text-xs font-medium text-zinc-100 flex items-center gap-1.5">
                              <span class="truncate">{opt.label}</span>
                              <Show when={opt.recommended}>
                                <span class="text-[8px] uppercase tracking-wide text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded-full shrink-0">
                                  ✓
                                </span>
                              </Show>
                            </div>
                            <div class="text-[10px] text-zinc-500 mt-0.5">{opt.description}</div>
                          </div>
                          <div class="pt-0.5 text-zinc-500 shrink-0">
                            <Show when={active()} fallback={<Circle size={12} />}>
                              <CheckCircle2 size={12} class="text-emerald-400" />
                            </Show>
                          </div>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </div>

              <div class="mt-4 flex justify-end">
                <Button variant="outline" class="text-xs" onClick={() => setModelPickerOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={templateModalOpen()}>
        <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3">
          <div class="bg-zinc-900 border border-zinc-800/70 w-full max-w-sm rounded-xl shadow-2xl overflow-hidden">
            <div class="p-4">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <h3 class="text-sm font-semibold text-white">Save Template</h3>
                  <p class="text-xs text-zinc-400 mt-0.5">Reuse a workflow with one tap.</p>
                </div>
                <Button variant="ghost" class="!p-1.5 rounded-full" onClick={() => setTemplateModalOpen(false)}>
                  <X size={14} />
                </Button>
              </div>

              <div class="mt-4 space-y-3">
                <TextInput
                  label="Title"
                  value={templateDraftTitle()}
                  onInput={(e) => setTemplateDraftTitle(e.currentTarget.value)}
                  placeholder="e.g. Daily standup summary"
                />

                <TextInput
                  label="Description (optional)"
                  value={templateDraftDescription()}
                  onInput={(e) => setTemplateDraftDescription(e.currentTarget.value)}
                  placeholder="What does this template do?"
                />

                <label class="block">
                  <div class="mb-1 text-xs font-medium text-neutral-300">Prompt</div>
                  <textarea
                    class="w-full min-h-24 rounded-lg bg-neutral-900/60 px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-500 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-white/20"
                    value={templateDraftPrompt()}
                    onInput={(e) => setTemplateDraftPrompt(e.currentTarget.value)}
                    placeholder="Write the instructions..."
                  />
                </label>
              </div>

              <div class="mt-4 flex justify-end gap-2">
                <Button variant="outline" class="text-xs" onClick={() => setTemplateModalOpen(false)}>
                  Cancel
                </Button>
                <Button class="text-xs" onClick={saveTemplate}>
                  Save
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
