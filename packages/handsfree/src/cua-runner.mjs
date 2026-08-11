export const CUA_DEFAULT_MODEL = "gpt-5.5";
export const CUA_MAX_TURNS = 30;

export async function runCuaLoop({
  task,
  apiKey,
  callTool,
  onProgress,
  signal,
  model = CUA_DEFAULT_MODEL,
  maxTurns = CUA_MAX_TURNS,
}) {
  if (!apiKey?.trim()) throw new Error("OpenAI API key required for computer use.");
  if (typeof callTool !== "function") throw new Error("callTool is required.");

  const display = await callTool("display_info", {});
  const displayInfo = normalizeDisplayInfo(parseToolText(display)) ?? { width: 1440, height: 900 };
  onProgress?.({ kind: "start", width: displayInfo.width, height: displayInfo.height });

  const items = [{ role: "user", content: String(task ?? "") }];
  const messages = [];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (signal?.aborted) return { ok: true, messages, turns: turn, aborted: true };
    onProgress?.({ kind: "turn", turn: turn + 1 });

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: items, tools: [{ type: "computer" }] }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`CUA API error ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const result = await response.json();
    const output = normalizeResponsesOutput(result);
    items.push(...output);

    let computerCall = null;
    for (const item of output) {
      if (item.type === "message") {
        const text = messageText(item);
        if (text) {
          messages.push(text);
          onProgress?.({ kind: "message", text });
        }
      }
      if (item.type === "computer_call") computerCall = item;
    }

    if (!computerCall) return { ok: true, messages, turns: turn + 1 };

    for (const action of computerCallActions(computerCall)) {
      if (signal?.aborted) return { ok: true, messages, turns: turn + 1, aborted: true };
      if (action.type === "screenshot") continue;
      onProgress?.({ kind: "action", ...summarizeAction(action) });
      const actionResult = await executeCuaAction(callTool, action);
      const actionPayload = normalizeToolResultPayload(parseToolText(actionResult), action.type);
      if (actionPayload?.ok === false) {
        if (actionPayload.requiredNextAction === "snapshot") break;
        throw new Error(actionPayload.error || `Computer action failed: ${action.type}`);
      }
      await delay(150);
    }

    const screenshot = await callTool("cua_screenshot", {});
    const image = extractImage(screenshot);
    if (!image) throw new Error("Could not capture screenshot after action.");

    items.push({
      type: "computer_call_output",
      call_id: computerCall.call_id,
      acknowledged_safety_checks: computerCall.pending_safety_checks || [],
      output: { type: "input_image", image_url: `data:image/png;base64,${image}` },
    });
  }

  return { ok: true, messages, turns: maxTurns, truncated: true };
}

export async function executeCuaAction(callTool, action) {
  const normalized = normalizeComputerAction(action);
  switch (normalized.type) {
    case "click":
      return callTool("cua_click", { x: normalized.x, y: normalized.y, button: normalized.button, ...(normalized.keys.length ? { keys: normalized.keys } : {}) });
    case "double_click":
      return callTool("cua_double_click", { x: normalized.x, y: normalized.y });
    case "scroll":
      return callTool("cua_scroll", { x: normalized.x, y: normalized.y, scroll_x: normalized.scroll_x, scroll_y: normalized.scroll_y });
    case "type":
      return callTool("cua_type", { text: normalized.text });
    case "keypress":
      return callTool("cua_keypress", { keys: normalized.keys });
    case "drag":
      return callTool("cua_drag", { path: normalized.path });
    case "move":
      return callTool("cua_move", { x: normalized.x, y: normalized.y });
    case "wait":
      return callTool("cua_wait", {});
    default:
      throw new Error(`Unsupported computer action: ${normalized.type}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a finite number.`);
  return number;
}

function stringValue(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function stringArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((entry, index) => stringValue(entry, `${field}[${index}]`));
}

function pointValue(value, field) {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  return { x: finiteNumber(value.x, `${field}.x`), y: finiteNumber(value.y, `${field}.y`) };
}

function normalizeComputerAction(action) {
  if (!isRecord(action)) throw new Error("Computer action must be an object.");
  const type = stringValue(action.type, "action.type");
  switch (type) {
    case "click":
      return { type, x: finiteNumber(action.x, "action.x"), y: finiteNumber(action.y, "action.y"), button: typeof action.button === "string" && action.button ? action.button : "left", keys: stringArray(action.keys, "action.keys") };
    case "double_click":
    case "move":
      return { type, x: finiteNumber(action.x, "action.x"), y: finiteNumber(action.y, "action.y") };
    case "scroll":
      return { type, x: finiteNumber(action.x, "action.x"), y: finiteNumber(action.y, "action.y"), scroll_x: action.scroll_x == null ? 0 : finiteNumber(action.scroll_x, "action.scroll_x"), scroll_y: action.scroll_y == null ? 0 : finiteNumber(action.scroll_y, "action.scroll_y") };
    case "type":
      return { type, text: stringValue(action.text, "action.text") };
    case "keypress":
      return { type, keys: stringArray(action.keys, "action.keys") };
    case "drag":
      if (!Array.isArray(action.path)) throw new Error("action.path must be an array.");
      return { type, path: action.path.map((point, index) => pointValue(point, `action.path[${index}]`)) };
    case "wait":
    case "screenshot":
      return { type };
    default:
      throw new Error(`Unsupported computer action: ${type}`);
  }
}

function normalizeResponsesOutput(result) {
  if (!isRecord(result)) throw new Error("CUA API response must be an object.");
  if (!Array.isArray(result.output) || result.output.length === 0) throw new Error("No output from CUA model.");
  for (const [index, item] of result.output.entries()) {
    if (!isRecord(item)) throw new Error(`CUA output[${index}] must be an object.`);
    if (typeof item.type !== "string") throw new Error(`CUA output[${index}].type must be a string.`);
    if (item.type === "message" && item.content !== undefined && !Array.isArray(item.content)) {
      throw new Error(`CUA message output[${index}].content must be an array.`);
    }
    if (item.type === "computer_call") {
      if (typeof item.call_id !== "string" || !item.call_id) throw new Error("CUA computer_call.call_id is required.");
      if (item.pending_safety_checks !== undefined && !Array.isArray(item.pending_safety_checks)) {
        throw new Error("CUA computer_call.pending_safety_checks must be an array.");
      }
      computerCallActions(item);
    }
  }
  return result.output;
}

function computerCallActions(computerCall) {
  const rawActions = Array.isArray(computerCall.actions)
    ? computerCall.actions
    : computerCall.action
      ? [computerCall.action]
      : [];
  if (rawActions.length === 0) throw new Error("CUA computer_call did not include an action.");
  return rawActions.map(normalizeComputerAction);
}

function messageText(item) {
  if (!Array.isArray(item.content)) return "";
  return item.content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("");
}

function normalizeDisplayInfo(payload) {
  if (!isRecord(payload)) return null;
  const width = Number(payload.width);
  const height = Number(payload.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width, height }
    : null;
}

function normalizeToolResultPayload(payload, actionType) {
  if (payload == null) return null;
  if (!isRecord(payload)) throw new Error(`Computer tool result for ${actionType} must be an object.`);
  return payload;
}

function parseToolText(response) {
  const text = response?.result?.content?.find?.((item) => item.type === "text")?.text
    ?? response?.content?.find?.((item) => item.type === "text")?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function extractImage(response) {
  const image = response?.result?.content?.find?.((item) => item.type === "image" && typeof item.data === "string" && item.data)?.data
    ?? response?.content?.find?.((item) => item.type === "image" && typeof item.data === "string" && item.data)?.data
    ?? null;
  return typeof image === "string" && image.trim() ? image.trim() : null;
}

function summarizeAction(action) {
  return {
    type: action.type,
    x: action.x,
    y: action.y,
    text: action.text?.slice?.(0, 60),
    desc: `${action.type}${action.x != null ? ` (${action.x},${action.y})` : ""}${action.text ? ` "${action.text.slice(0, 30)}"` : ""}`,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
