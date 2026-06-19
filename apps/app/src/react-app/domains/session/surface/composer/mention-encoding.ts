/** What a composer `@token` refers to: an agent, a workspace file, or a macOS app (Computer Use target). */
export type ComposerMentionKind = "agent" | "file" | "app";

/**
 * Percent-encode a mention value so it can be embedded in the draft as a single `@token` with no spaces.
 * @param value The raw mention value to encode.
 */
export function encodeComposerMentionValue(value: string) {
  return value.replaceAll("%", "%25").replaceAll(" ", "%20");
}

/**
 * Recover the original mention value from its encoded form. Preserves literal `%20` sequences in the original.
 * @param value The encoded mention value to decode.
 */
export function decodeComposerMentionValue(value: string) {
  return value.replaceAll("%20", " ").replaceAll("%25", "%");
}
