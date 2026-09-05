/**
 * A `[connector …]` composer draft token names the connection (GitHub, Gmail,
 * Notion, …) a prompt is about. The composer renders it as a chip ahead of
 * the text; the send path expands it into a short steering sentence so the
 * model reaches for that connector's tools. Den's connector catalog seeds it
 * through the `openwork://chat` deep link.
 */
function sanitizeConnectorName(name: string) {
  return name.replace(/[\[\]\n\r]/g, "").trim();
}

export function encodeConnectorToken(name: string) {
  return `[connector ${sanitizeConnectorName(name)}]`;
}

/** The connector name carried by one `[connector …]` segment, or null. */
export function parseConnectorToken(segment: string): string | null {
  const match = segment.match(/^\[connector (.+)\]$/);
  const name = match?.[1]?.trim();
  return name ? name : null;
}

/** Expand a connector token into the model-facing steering text (same precedent as the skill load instruction). */
export function connectorPrompt(name: string) {
  return `Use the "${name}" connector's tools for this request.`;
}

/** Draft text for a seeded chat: the connector chip, then the prompt. */
export function seededConnectorDraft(input: { connector: string | null; prompt: string }) {
  const prompt = input.prompt.trim();
  if (!input.connector) return prompt;
  const token = encodeConnectorToken(input.connector);
  return prompt ? `${token} ${prompt}` : `${token} `;
}
