import { t } from "@/i18n";

/**
 * OpenCode ships built-in agents whose raw names (e.g. "build") read as
 * developer jargon in the composer. Map the known ones to friendly,
 * self-explanatory labels so non-technical users can pick them without needing
 * agent vocabulary. Custom agents keep their capitalized name.
 */
const FRIENDLY_AGENT_LABEL_KEYS: Record<string, string> = {
  build: "composer.agent_general_purpose",
};

export function formatComposerAgentLabel(name: string): string {
  const friendlyKey = FRIENDLY_AGENT_LABEL_KEYS[name];
  if (friendlyKey) return t(friendlyKey);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
