export type ParsedDashboardAppInput =
  | { ok: true; launchArguments?: Record<string, unknown> }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatDashboardAppInput(launchArguments: Record<string, unknown> | undefined): string {
  return launchArguments ? JSON.stringify(launchArguments, null, 2) : "";
}

export function parseDashboardAppInput(text: string, required: boolean): ParsedDashboardAppInput {
  const trimmed = text.trim();
  if (!trimmed) {
    return required
      ? { ok: false, message: "This app requires tool input." }
      : { ok: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: "Tool input must be valid JSON." };
  }

  if (!isRecord(parsed)) {
    return { ok: false, message: "Tool input must be a JSON object." };
  }
  if (required && Object.keys(parsed).length === 0) {
    return { ok: false, message: "This app requires at least one input value." };
  }
  return Object.keys(parsed).length > 0
    ? { ok: true, launchArguments: parsed }
    : { ok: true };
}
