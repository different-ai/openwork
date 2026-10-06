/** Keep each API path and schema on its own line without expanding every
 * nested schema into thousands of lines. Keep deterministic route-registration
 * order so formatting alone never reorders the SDK's methods or types. */
function entries(value: Record<string, unknown>, indent: string): string {
  return Object.keys(value).map((key) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(value[key])}`).join(",\n");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatComponents(value: Record<string, unknown>): string {
  const lines = Object.keys(value).map((key) => {
    const entry = value[key];
    return `    ${JSON.stringify(key)}: ${record(entry) ? `{\n${entries(entry, "      ")}\n    }` : JSON.stringify(entry)}`;
  });
  return `{\n${lines.join(",\n")}\n  }`;
}

export function formatOpenApiSnapshot(document: Record<string, unknown>): string {
  const lines = Object.keys(document).map((key) => {
    const value = document[key];
    if (record(value) && (key === "paths" || key === "webhooks")) {
      return `  ${JSON.stringify(key)}: {\n${entries(value, "    ")}\n  }`;
    }
    if (key === "components" && record(value)) {
      return `  ${JSON.stringify(key)}: ${formatComponents(value)}`;
    }
    return `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  });
  return `{\n${lines.join(",\n")}\n}\n`;
}
