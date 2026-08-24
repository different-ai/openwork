import type { OpenworkSessionExportFormat } from "./openwork-server";

/**
 * Pure helpers for moving session bundles between the app and the filesystem.
 *
 * Kept free of React and of the server client so they can be unit tested
 * directly.
 */

export const SESSION_EXPORT_FORMAT_ID = "openwork.session-export";

function slugify(label: string): string {
  return label
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function sessionExportFilename(label: string, format: OpenworkSessionExportFormat): string {
  const slug = slugify(label) || "session";
  return `${slug}-openwork-session.${format === "markdown" ? "md" : "json"}`;
}

export function workspaceSessionsExportFilename(label: string, format: OpenworkSessionExportFormat): string {
  const slug = slugify(label) || "workspace";
  return `${slug}-openwork-sessions.${format === "markdown" ? "md" : "json"}`;
}

export class SessionBundleFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBundleFileError";
  }
}

/**
 * Validate a picked file before sending it to the server, so an obviously wrong
 * file fails immediately with a clear message instead of a round trip.
 *
 * Returns the parsed payload as `unknown`: the server owns full schema
 * validation, and pretending otherwise here would just be an unchecked cast.
 */
export function readSessionBundleFile(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SessionBundleFileError("That file is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SessionBundleFileError("That file is not an OpenWork session export");
  }

  const candidate: Record<string, unknown> = { ...parsed };
  if (candidate.format !== SESSION_EXPORT_FORMAT_ID) {
    throw new SessionBundleFileError("That file is not an OpenWork session export");
  }
  if (typeof candidate.version !== "number") {
    throw new SessionBundleFileError("That session export is missing a version");
  }
  if (!Array.isArray(candidate.sessions) || candidate.sessions.length === 0) {
    throw new SessionBundleFileError("That session export contains no sessions");
  }

  return parsed;
}

/**
 * Prompt for a bundle file. Resolves to null when the user cancels.
 */
export function pickSessionBundleFileText(): Promise<string | null> {
  if (typeof document === "undefined") return Promise.resolve(null);

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.style.display = "none";

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      file.text().then(finish).catch(() => finish(null));
    });
    input.addEventListener("cancel", () => finish(null));

    document.body.appendChild(input);
    input.click();
  });
}
