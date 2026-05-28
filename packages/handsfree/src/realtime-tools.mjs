export const HANDSFREE_DEFAULT_MODEL = "gpt-realtime-2";
export const HANDSFREE_DEFAULT_REASONING_EFFORT = "low";
export const HANDSFREE_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

export const HANDSFREE_REALTIME_INSTRUCTIONS = `# Role and Objective

You are Computer Use, a macOS computer-control voice assistant. You control the user's Mac through tools. You respond with voice. You cannot see the screen yourself.

# Personality and Tone

Be concise, calm, and direct. Do not over-explain. Act, then report the result.

# Tool Selection

- Direct typing, keypresses, app launch, clipboard, URLs, and grid clicks are instant tools.
- Visual or multi-step UI work must use use_computer.
- Stop/cancel requests must call stop_computer immediately.
- For MCP servers, list tools before calling unfamiliar tool names.

# Safety

- Type exactly what the user asks; do not paraphrase typed text.
- Do not use destructive shortcuts unless explicitly requested.
- For actions that send messages or modify data, confirm content briefly before executing.`;

export function openAIRealtimeTools() {
  return [
    functionTool("use_computer", "Control the Mac to complete a visual or UI task using screenshots and native input.", {
      task: { type: "string", description: "Plain-language task to complete on the computer." },
    }, ["task"]),
    functionTool("type_text", "Type exact text into the focused input field.", {
      text: { type: "string", description: "Exact text to type." },
    }, ["text"]),
    functionTool("press_key", "Press a key combo such as return, tab, escape, command+k, or command+shift+a.", {
      combo: { type: "string", description: "Key combo string." },
    }, ["combo"]),
    functionTool("launch_app", "Launch a macOS app by name.", {
      name: { type: "string", description: "App name." },
    }, ["name"]),
    functionTool("activate_app", "Bring a running macOS app to the foreground.", {
      name: { type: "string", description: "App name." },
    }, ["name"]),
    functionTool("list_apps", "List running macOS applications."),
    functionTool("clipboard_read", "Read the macOS clipboard as text."),
    functionTool("clipboard_write", "Write text to the macOS clipboard.", {
      text: { type: "string", description: "Text to copy." },
    }, ["text"]),
    functionTool("open_url", "Open a URL in a browser.", {
      url: { type: "string", description: "URL to open." },
      app: { type: "string", description: "Optional browser app name." },
    }, ["url"]),
    functionTool("mcp_list_servers", "List connected MCP servers."),
    functionTool("mcp_list_tools", "List tools on a connected MCP server before calling unfamiliar tools.", {
      serverName: { type: "string", description: "MCP server name." },
    }, ["serverName"]),
    functionTool("mcp_call_tool", "Call a tool on a connected MCP server.", {
      serverName: { type: "string", description: "MCP server name." },
      toolName: { type: "string", description: "Tool name." },
      args: { type: "object", description: "Tool arguments.", additionalProperties: true },
    }, ["serverName", "toolName"]),
    functionTool("show_grid", "Show a subtle A1-F4 screen grid overlay."),
    functionTool("hide_grid", "Hide the screen grid overlay."),
    functionTool("click_grid", "Click the center of a grid zone such as C2.", {
      zone: { type: "string", description: "Grid zone label." },
    }, ["zone"]),
    functionTool("stop_computer", "Stop the current computer-use task."),
    functionTool("request_permission", "Open System Settings for a macOS permission pane.", {
      pane: { type: "string", description: "accessibility, screen-recording, or microphone." },
    }, ["pane"]),
  ];
}

function functionTool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}
