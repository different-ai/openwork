const SLASH_COMMAND_QUERY_RE = /^\/([A-Za-z0-9_-]*)$/;
const SLASH_COMMAND_INVOCATION_RE = /^\/([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/;

export function getSlashCommandQuery(value: string) {
  const match = value.match(SLASH_COMMAND_QUERY_RE);
  return match ? match[1] : null;
}

export function parseSlashCommandInvocation(value: string) {
  const match = value.trim().match(SLASH_COMMAND_INVOCATION_RE);
  if (!match) return null;
  const name = match[1];
  if (!name) return null;
  return { name, arguments: match[2] ?? "" };
}
