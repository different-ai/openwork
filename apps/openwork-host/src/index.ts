import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import { SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { KnownProvider } from "@mariozechner/pi-ai";

type SessionInfo = {
  id: string;
  title: string;
  parentID: string | null;
  time: {
    created: number;
    updated: number;
  };
};

type UserMessageInfo = {
  id: string;
  sessionID: string;
  role: "user";
  time: {
    created: number;
  };
  agent: string;
  model: {
    providerID: string;
    modelID: string;
  };
};

type AssistantMessageInfo = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  finish?: string;
  error?: {
    name: string;
    data: {
      message: string;
    };
  };
};

type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  time?: {
    start: number;
    end?: number;
  };
};

type StoredMessage = {
  info: UserMessageInfo | AssistantMessageInfo;
  parts: TextPart[];
};

type HostEvent = {
  type: string;
  properties: Record<string, unknown>;
};

type HostSession = {
  info: SessionInfo;
  runtime: Awaited<ReturnType<typeof createAgentSession>>["session"];
  messages: StoredMessage[];
  busy: boolean;
  current: {
    userMessageId: string;
    assistantMessageId: string;
    assistantPartId: string;
  } | null;
};

class EventBus {
  listeners = new Set<(event: HostEvent) => void>();

  publish(event: HostEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: (event: HostEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const cwd = process.env.OPENWORK_HOST_WORKSPACE_DIR || process.cwd();
const port = Number(process.env.OPENWORK_HOST_PORT || "8788");
const providerID = (process.env.OPENWORK_HOST_MODEL_PROVIDER || "openai") as KnownProvider;
const modelID = process.env.OPENWORK_HOST_MODEL_ID || "gpt-4.1-mini";
const version = "0.0.1-pi";
const bus = new EventBus();
const sessions = new Map<string, HostSession>();

const app = new Hono();

function now() {
  return Date.now();
}

function publish(event: HostEvent) {
  bus.publish(event);
}

function createSessionInfo(title?: string): SessionInfo {
  const time = now();
  return {
    id: nanoid(),
    title: title?.trim() || "New chat",
    parentID: null,
    time: {
      created: time,
      updated: time,
    },
  };
}

async function createHostSession(title?: string) {
  const session = await createAgentSession({
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    model: getModel(providerID as any, modelID as any),
  });

  const host: HostSession = {
    info: createSessionInfo(title),
    runtime: session.session,
    messages: [],
    busy: false,
    current: null,
  };

  session.session.subscribe((event) => {
    if (!host.current) {
      if (event.type === "turn_end" || event.type === "agent_end") {
        host.busy = false;
        host.info.time.updated = now();
        publish({
          type: "session.idle",
          properties: { sessionID: host.info.id },
        });
      }
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const message = host.messages.find((item) => item.info.id === host.current?.assistantMessageId);
      const part = message?.parts.find((item) => item.id === host.current?.assistantPartId);
      if (!message || !part) return;
      part.text += event.assistantMessageEvent.delta;
      host.info.time.updated = now();
      publish({
        type: "message.part.delta",
        properties: {
          sessionID: host.info.id,
          messageID: message.info.id,
          partID: part.id,
          field: "text",
          delta: event.assistantMessageEvent.delta,
        },
      });
      return;
    }

    if (event.type === "turn_end") {
      const message = host.messages.find((item) => item.info.id === host.current?.assistantMessageId);
      if (message && message.info.role === "assistant") {
        message.info.time.completed = now();
        message.info.finish = "stop";
      }
      host.busy = false;
      host.current = null;
      host.info.time.updated = now();
      publish({
        type: "session.idle",
        properties: { sessionID: host.info.id },
      });
      publish({
        type: "session.updated",
        properties: { info: host.info },
      });
      return;
    }

    if (event.type === "agent_end") {
      host.busy = false;
      host.current = null;
      host.info.time.updated = now();
      publish({
        type: "session.idle",
        properties: { sessionID: host.info.id },
      });
      return;
    }
  });

  sessions.set(host.info.id, host);
  publish({ type: "session.created", properties: { info: host.info } });
  return host;
}

function requireSession(sessionID: string) {
  const session = sessions.get(sessionID);
  if (!session) {
    throw new Error(`Session not found: ${sessionID}`);
  }
  return session;
}

function appendUserMessage(session: HostSession, text: string) {
  const info: UserMessageInfo = {
    id: nanoid(),
    sessionID: session.info.id,
    role: "user",
    time: { created: now() },
    agent: "pi-coding-agent",
    model: {
      providerID,
      modelID,
    },
  };
  const part: TextPart = {
    id: nanoid(),
    sessionID: session.info.id,
    messageID: info.id,
    type: "text",
    text,
    time: { start: info.time.created, end: info.time.created },
  };
  const message: StoredMessage = { info, parts: [part] };
  session.messages.push(message);
  publish({ type: "message.updated", properties: { info } });
  publish({ type: "message.part.updated", properties: { part } });
  return message;
}

function appendAssistantMessage(session: HostSession, parentID: string) {
  const created = now();
  const info: AssistantMessageInfo = {
    id: nanoid(),
    sessionID: session.info.id,
    role: "assistant",
    time: { created },
    parentID,
    modelID,
    providerID,
    mode: "pi",
    agent: "pi-coding-agent",
    path: {
      cwd,
      root: cwd,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  const part: TextPart = {
    id: nanoid(),
    sessionID: session.info.id,
    messageID: info.id,
    type: "text",
    text: "",
    time: { start: created },
  };
  const message: StoredMessage = { info, parts: [part] };
  session.messages.push(message);
  publish({ type: "message.updated", properties: { info } });
  publish({ type: "message.part.updated", properties: { part } });
  return message;
}

function eventPayload(event: HostEvent) {
  return JSON.stringify(event);
}

app.get("/health", (c) => c.json({ ok: true, version }));
app.get("/global/health", (c) => c.json({ healthy: true, version }));

app.get("/session", (c) => {
  const roots = c.req.query("roots");
  const items = Array.from(sessions.values()).map((item) => item.info);
  if (roots === "true") {
    return c.json(items.filter((item) => !item.parentID));
  }
  return c.json(items);
});

app.post("/session", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const session = await createHostSession(typeof body?.title === "string" ? body.title : undefined);
  return c.json(session.info);
});

app.patch("/session/:sessionID", async (c) => {
  const session = requireSession(c.req.param("sessionID"));
  const body = await c.req.json().catch(() => ({}));
  if (typeof body?.title === "string" && body.title.trim()) {
    session.info.title = body.title.trim();
    session.info.time.updated = now();
    publish({ type: "session.updated", properties: { info: session.info } });
  }
  return c.json(session.info);
});

app.get("/session/:sessionID/message", (c) => {
  const session = requireSession(c.req.param("sessionID"));
  return c.json(session.messages);
});

app.post("/session/:sessionID/abort", async (c) => {
  const session = requireSession(c.req.param("sessionID"));
  session.runtime.abort();
  session.busy = false;
  session.current = null;
  publish({ type: "session.idle", properties: { sessionID: session.info.id } });
  return c.json(true);
});

app.post("/session/:sessionID/prompt_async", async (c) => {
  const session = requireSession(c.req.param("sessionID"));
  const body = await c.req.json();
  const text = Array.isArray(body?.parts)
    ? body.parts
        .filter((part: { type?: string; text?: string }) => part?.type === "text" && typeof part.text === "string")
        .map((part: { text: string }) => part.text)
        .join("\n")
        .trim()
    : "";

  if (!text) {
    return c.body(null, 204);
  }

  const user = appendUserMessage(session, text);
  const assistant = appendAssistantMessage(session, user.info.id);
  session.current = {
    userMessageId: user.info.id,
    assistantMessageId: assistant.info.id,
    assistantPartId: assistant.parts[0]!.id,
  };
  session.busy = true;
  session.info.time.updated = now();
  publish({ type: "session.status", properties: { sessionID: session.info.id, status: "busy" } });
  publish({ type: "session.updated", properties: { info: session.info } });

  queueMicrotask(async () => {
    try {
      await session.runtime.prompt(text);
    } catch (error) {
      const message = session.messages.find((item) => item.info.id === session.current?.assistantMessageId);
      const part = message?.parts.find((item) => item.id === session.current?.assistantPartId);
      const delta = `Error: ${error instanceof Error ? error.message : String(error)}`;
      if (message && message.info.role === "assistant") {
        message.info.error = {
          name: "UnknownError",
          data: { message: delta },
        };
        message.info.time.completed = now();
      }
      if (part) {
        part.text += delta;
        publish({
          type: "message.part.delta",
          properties: {
            sessionID: session.info.id,
            messageID: message?.info.id,
            partID: part.id,
            field: "text",
            delta,
          },
        });
      }
      session.busy = false;
      session.current = null;
      publish({ type: "session.idle", properties: { sessionID: session.info.id } });
    }
  });

  return c.body(null, 204);
});

app.get("/event", async (c) => {
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
  c.header("X-Content-Type-Options", "nosniff");

  return streamSSE(c, async (stream) => {
    const push = (event: HostEvent) => stream.writeSSE({ data: eventPayload(event) });
    await push({ type: "server.connected", properties: {} });
    const heartbeat = setInterval(() => {
      void push({ type: "server.heartbeat", properties: {} });
    }, 10_000);
    const unsubscribe = bus.subscribe((event) => {
      void push(event);
    });

    stream.onAbort(() => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    await new Promise<void>(() => {
      // Keep the stream open until the client disconnects.
    });
  });
});

serve(
  {
    fetch: app.fetch,
    port,
    hostname: "127.0.0.1",
  },
  (info) => {
    process.stdout.write(`openwork-host listening on http://${info.address}:${info.port}\n`);
  },
);
