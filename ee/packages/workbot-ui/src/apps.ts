import type { WorkbotApp } from "./data";

/** The plain status of an app on the Apps list, and the dot beside it. */
export const APP_STATUS: Record<WorkbotApp["status"], { label: string; dot: string }> = {
  connected: { label: "Connected", dot: "bg-[#30a46c]" },
  needs_sign_in: { label: "Needs sign-in", dot: "bg-[var(--wb-disabled)]" },
  not_connected: { label: "Not connected", dot: "bg-[var(--wb-disabled)]" },
  needs_attention: { label: "Needs attention", dot: "bg-[var(--wb-danger)]" },
};

/** What the person can do about an app that isn't connected: Connect, or a note when only an admin can fix it. */
export function appNote(app: WorkbotApp): string | null {
  return app.action === "ask_admin" ? "Ask your admin" : app.action === "admin_settings" ? "Fix in OpenWork settings" : null;
}
