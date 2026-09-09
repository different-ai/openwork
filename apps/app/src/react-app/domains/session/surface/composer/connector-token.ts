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
  return `This request is about the "${name}" connector; do not assume it is connected or that its tools are available. Answer planning and general questions without requiring a connection. For work needing live data or actions, discover capabilities normally with search_capabilities, omitting intent connect. Offer setup only if the requested operation needs an unavailable connection or the user explicitly asks to connect or set up the service; use intent connect only for an explicit setup request. Follow returned connection guidance and let the user authorize any connection themselves. This connector selection does not authorize sign-in, scope changes, or external writes; perform writes only when explicitly requested.`;
}

/** Draft text for a seeded chat: the connector chip, then the prompt. */
export function seededConnectorDraft(input: { connector: string | null; prompt: string }) {
  const prompt = input.prompt.trim();
  if (!input.connector) return prompt;
  const token = encodeConnectorToken(input.connector);
  return prompt ? `${token} ${prompt}` : `${token} `;
}
