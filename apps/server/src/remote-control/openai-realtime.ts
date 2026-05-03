import { ApiError } from "../errors.js";
import { EnvService } from "../env-file.js";

export const REMOTE_CONTROL_DEFAULT_MODEL = "gpt-realtime-1.5";
export const REMOTE_CONTROL_DEFAULT_VOICE = "marin";
export const REMOTE_CONTROL_DEFAULT_INSTRUCTIONS = [
  "You are controlling the OpenWork app through a provider-neutral control surface.",
  "You CAN see the current session. Use read_transcript to read messages in the active session. Use get_latest_message for just the newest message.",
  "Use snapshot or list_actions before choosing an action unless the user named an obvious action.",
  "Narrate briefly before and after actions. Keep answers concise.",
  "Prefer set_input for typing text and execute_action for navigation or buttons.",
  "Ask for explicit confirmation before destructive actions like deleting sessions.",
  "Do not invent action IDs. Only use IDs returned by list_actions or snapshot.",
  "When the user asks about session content, always call read_transcript or get_latest_message first — do not say you cannot see the session.",
].join(" ");

function openAIRealtimeTools() {
  return [
    {
      type: "function",
      name: "snapshot",
      description: "Read the current OpenWork route, control status, narration, and available actions.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "list_actions",
      description: "List currently available OpenWork app actions with IDs, labels, descriptions, and disabled state.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "execute_action",
      description: "Execute an available OpenWork action by ID. Use args only when the action requires them.",
      parameters: {
        type: "object",
        properties: {
          actionId: {
            type: "string",
            description: "An action ID returned by snapshot or list_actions.",
          },
          args: {
            type: "object",
            description: "Optional arguments for the action.",
            additionalProperties: true,
          },
        },
        required: ["actionId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "set_input",
      description: "Type text into a text-entry action such as the session composer.",
      parameters: {
        type: "object",
        properties: {
          actionId: {
            type: "string",
            description: "The text-entry action ID, usually composer.set_text.",
          },
          text: {
            type: "string",
            description: "The exact text to type visibly into the app.",
          },
        },
        required: ["actionId", "text"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "list_sessions",
      description: "List available sessions across workspaces with their IDs and titles so you can navigate to one by name.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "open_session",
      description: "Navigate to a specific session by its ID. Use list_sessions first to find the right ID.",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "The session ID returned by list_sessions.",
          },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "rename_session",
      description: "Rename a session by ID. Use list_sessions first to identify the exact session the user means.",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "The session ID returned by list_sessions.",
          },
          title: {
            type: "string",
            description: "The new session title.",
          },
        },
        required: ["sessionId", "title"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "delete_session",
      description: "Delete a session by ID. Destructive: only set confirmed true after the user explicitly confirms deletion.",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "The session ID returned by list_sessions.",
          },
          confirmed: {
            type: "boolean",
            description: "Must be true only after explicit user confirmation.",
          },
        },
        required: ["sessionId", "confirmed"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "scroll_session",
      description: "Scroll the current session transcript to the top or bottom.",
      parameters: {
        type: "object",
        properties: {
          position: {
            type: "string",
            enum: ["top", "bottom"],
            description: "Where to scroll the current session transcript.",
          },
        },
        required: ["position"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "get_latest_message",
      description: "Read the latest visible message in the current session transcript.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "read_transcript",
      description: "Read the last N messages from the current session transcript. Returns session ID, total message count, and each message's role and text. Use this when the user asks about the current session's content.",
      parameters: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "Number of recent messages to return (1–30, default 10).",
          },
        },
        additionalProperties: false,
      },
    },
  ];
}

async function resolveOpenAIKey(env: EnvService): Promise<string> {
  const processKey = process.env.OPENAI_API_KEY?.trim();
  if (processKey) return processKey;

  let savedEnv: Awaited<ReturnType<EnvService["list"]>> = [];
  try {
    savedEnv = await env.list();
  } catch {
    throw new ApiError(409, "openai_api_key_store_unreadable", "OpenWork could not read the saved OpenAI API key");
  }
  return savedEnv.find((entry) => entry.key === "OPENAI_API_KEY")?.value.trim() ?? "";
}

export async function createRemoteControlSession(input: { model: string; voice: string; instructions: string }, env: EnvService) {
  const apiKey = await resolveOpenAIKey(env);
  if (!apiKey) {
    throw new ApiError(400, "openai_api_key_missing", "Add an OpenAI API key in Settings → Feature Preview before starting Realtime control");
  }

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: input.model,
        output_modalities: ["text"],
        audio: {
          input: {
            transcription: {
              model: "gpt-4o-mini-transcribe",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              silence_duration_ms: 200,
              prefix_padding_ms: 300,
              create_response: true,
              interrupt_response: false,
            },
          },
        },
        instructions: input.instructions,
        tool_choice: "auto",
        tools: openAIRealtimeTools(),
      },
    }),
  });

  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message = typeof json?.error?.message === "string" ? json.error.message : response.statusText;
    throw new ApiError(response.status, "openai_realtime_session_failed", message || "Failed to create remote control session");
  }

  const clientSecret =
    typeof json?.client_secret?.value === "string"
      ? json.client_secret.value
      : typeof json?.value === "string"
        ? json.value
        : typeof json?.client_secret === "string"
          ? json.client_secret
          : "";
  if (!clientSecret) {
    throw new ApiError(502, "openai_realtime_session_invalid", "OpenAI did not return a usable realtime client secret");
  }

  const expiresAt =
    typeof json?.client_secret?.expires_at === "number"
      ? json.client_secret.expires_at
      : typeof json?.expires_at === "number"
        ? json.expires_at
        : null;

  return {
    clientSecret,
    expiresAt,
    model: input.model,
    voice: input.voice,
    tools: openAIRealtimeTools().map((tool) => tool.name),
  };
}
