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
  const displayInfo = parseToolText(display) ?? { width: 1440, height: 900 };
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
    const output = result.output || [];
    if (!output.length) throw new Error("No output from CUA model.");
    items.push(...output);

    let computerCall = null;
    for (const item of output) {
      if (item.type === "message") {
        const text = item.content?.map((part) => part.text || "").join("") || "";
        if (text) {
          messages.push(text);
          onProgress?.({ kind: "message", text });
        }
      }
      if (item.type === "computer_call") computerCall = item;
    }

    if (!computerCall) return { ok: true, messages, turns: turn + 1 };

    for (const action of computerCall.actions || (computerCall.action ? [computerCall.action] : [])) {
      if (signal?.aborted) return { ok: true, messages, turns: turn + 1, aborted: true };
      if (action.type === "screenshot") continue;
      onProgress?.({ kind: "action", ...summarizeAction(action) });
      const actionResult = await executeCuaAction(callTool, action);
      const actionPayload = parseToolText(actionResult);
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
  switch (action.type) {
    case "click":
      return callTool("cua_click", { x: action.x, y: action.y, button: action.button || "left", ...(action.keys?.length ? { keys: action.keys } : {}) });
    case "double_click":
      return callTool("cua_double_click", { x: action.x, y: action.y });
    case "scroll":
      return callTool("cua_scroll", { x: action.x, y: action.y, scroll_x: action.scroll_x || 0, scroll_y: action.scroll_y || 0 });
    case "type":
      return callTool("cua_type", { text: action.text });
    case "keypress":
      return callTool("cua_keypress", { keys: action.keys || [] });
    case "drag":
      return callTool("cua_drag", { path: action.path || [] });
    case "move":
      return callTool("cua_move", { x: action.x, y: action.y });
    case "wait":
      return callTool("cua_wait", {});
    default:
      return null;
  }
}

function parseToolText(response) {
  const text = response?.result?.content?.find?.((item) => item.type === "text")?.text
    ?? response?.content?.find?.((item) => item.type === "text")?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function extractImage(response) {
  return response?.result?.content?.find?.((item) => item.type === "image" && item.data)?.data
    ?? response?.content?.find?.((item) => item.type === "image" && item.data)?.data
    ?? null;
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
