function computerUseUrl(id: string, path: string): string {
  const base = (process.env.DAYTONA_TOOLBOX_URL || "https://proxy.app.daytona.io/toolbox").replace(/\/$/, "");
  return `${base}/${encodeURIComponent(id)}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function computerUseRequest(id: string, path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const apiKey = process.env.DAYTONA_API_KEY?.trim();
  if (!apiKey) throw new Error("Daytona Computer Use requires DAYTONA_API_KEY.");
  const response = await fetch(computerUseUrl(id, path), {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Daytona Computer Use ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

export async function captureDaytonaComputerUseScreenshot(id: string): Promise<Buffer> {
  const result = await computerUseRequest(id, "/computeruse/screenshot");
  const encoded = isRecord(result) && typeof result.screenshot === "string"
    ? result.screenshot.replace(/^data:image\/png;base64,/, "")
    : "";
  if (!encoded) throw new Error("Daytona Computer Use returned an empty screenshot.");
  return Buffer.from(encoded, "base64");
}

export async function daytonaComputerUseHotkey(id: string, keys: string[]): Promise<void> {
  await computerUseRequest(id, "/computeruse/keyboard/hotkey", {
    method: "POST",
    body: { keys },
  });
}

export async function daytonaComputerUsePress(id: string, key: string, modifiers: string[] = []): Promise<void> {
  await computerUseRequest(id, "/computeruse/keyboard/key", {
    method: "POST",
    body: { key, modifiers },
  });
}

export async function daytonaComputerUseStart(id: string): Promise<unknown> {
  return computerUseRequest(id, "/computeruse/start", {
    method: "POST",
    body: {},
  });
}

export async function daytonaComputerUseType(id: string, value: string): Promise<void> {
  await computerUseRequest(id, "/computeruse/keyboard/type", {
    method: "POST",
    body: { text: value, delay: 1 },
  });
}

export function daytonaComputerUseWindows(id: string): Promise<unknown> {
  return computerUseRequest(id, "/computeruse/display/windows");
}
