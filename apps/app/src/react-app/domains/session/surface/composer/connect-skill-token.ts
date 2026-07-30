import { t } from "@/i18n";

/**
 * Fields carried by a `[connect-skill …]` composer draft token.
 * The token keeps the full connect-skill invocation self-contained in the
 * draft text so the composer can render a compact `/slug` pill while the
 * send path expands it back into the full connect prompt.
 */
export type ConnectSkillToken = {
  /** Slash-command style display slug (e.g. `daytona-chrome-cdp`). */
  slug: string;
  /** Human-readable skill name used in the prompt. */
  name: string;
  marketplace: string;
  capability: string;
};

/** Regex source matching one `[connect-skill …]` token (no capture group). */
export const CONNECT_SKILL_TOKEN_RE_SOURCE = String.raw`\[connect-skill [^\]]+\]`;

const FIELD_SEPARATOR = "|";

function encodeField(value: string) {
  return value.replaceAll("%", "%25").replaceAll("|", "%7C").replaceAll("]", "%5D");
}

function decodeField(value: string) {
  return value.replaceAll("%5D", "]").replaceAll("%7C", "|").replaceAll("%25", "%");
}

export function encodeConnectSkillToken(token: ConnectSkillToken) {
  const fields = [token.slug, token.name, token.marketplace, token.capability].map(encodeField);
  return `[connect-skill ${fields.join(FIELD_SEPARATOR)}]`;
}

export function parseConnectSkillToken(segment: string): ConnectSkillToken | null {
  const match = segment.match(/^\[connect-skill (.+)\]$/);
  if (!match?.[1]) return null;
  const fields = match[1].split(FIELD_SEPARATOR).map(decodeField);
  const [slug, name, marketplace, capability] = fields;
  if (fields.length !== 4 || !slug || !name || !marketplace || !capability) return null;
  return { slug, name, marketplace, capability };
}

/** Expand a connect-skill token into the full prompt sent to the model. */
export function connectSkillPrompt(token: ConnectSkillToken) {
  return t("composer.connect_skill_prompt", {
    name: token.name,
    marketplace: token.marketplace,
    capability: token.capability,
  });
}
