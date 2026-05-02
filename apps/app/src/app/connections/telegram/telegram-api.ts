/**
 * Telegram API client.
 * NEVER calls opencode-router directly.
 * All requests proxy through openwork-server per ARCHITECTURE.md.
 */

export interface TelegramIdentity {
  id: string;
  botUsername?: string;
  workspacePath: string;
  status: "connected" | "disconnected" | "error";
  errorMessage?: string;
}

function getBase(): string {
  return (window as any).__OPENWORK_SERVER_URL__ ?? "http://localhost:7878";
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = (window as any).__OPENWORK_TOKEN__ ?? "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchTelegramIdentities(
  workspacePath: string
): Promise<TelegramIdentity[]> {
  try {
    const params = new URLSearchParams({ workspacePath });
    const res = await fetch(`${getBase()}/opencode-router/identities?${params}`, {
      headers: await authHeaders(),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.identities ?? [];
  } catch {
    return [];
  }
}

export async function upsertTelegramIdentity(
  botToken: string,
  workspacePath: string
): Promise<{ ok: boolean; identity?: TelegramIdentity; error?: string }> {
  try {
    const res = await fetch(`${getBase()}/opencode-router/identities/telegram`, {
      method: "POST",
      headers: {
        ...(await authHeaders()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ botToken, workspacePath }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? "Failed" };
    return { ok: true, identity: data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function deleteTelegramIdentity(id: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${getBase()}/opencode-router/identities/telegram/${id}`,
      { method: "DELETE", headers: await authHeaders() }
    );
    return res.ok;
  } catch {
    return false;
  }
}
