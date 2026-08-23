import { EnvService } from "./env-file.js";

export async function resolveCursorApiKey(envService?: EnvService): Promise<string> {
  try {
    const stored = (await (envService ?? new EnvService()).list())
      .find((entry) => entry.key === "CURSOR_API_KEY")
      ?.value.trim() ?? "";
    if (stored) return stored;
  } catch {
    // Missing or unreadable env store is not a Cursor-key signal.
  }
  return process.env.CURSOR_API_KEY?.trim() ?? "";
}
