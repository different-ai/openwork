const CONFIRMATION = "DELETE";

/** Matching letters affect the illustration only; permission requires the whole exact value. */
export function resetConfirmation(value: string): { progress: number; confirmed: boolean } {
  let matched = 0;
  while (matched < CONFIRMATION.length && value[matched] === CONFIRMATION[matched]) matched += 1;
  return { progress: matched / CONFIRMATION.length, confirmed: value === CONFIRMATION };
}

const ROLE_LINES: Record<string, string> = {
  research: "Wait! I had one more footnote...",
  operations: "But I just alphabetized everything!",
  writing: "Can I keep the glasses?",
  creative: "Can I keep the glasses?",
  design: "Can I keep the glasses?",
  product: "Wait! This wasn't on the roadmap!",
  developer: "But it finally works on my machine!",
  engineering: "But it finally works on my machine!",
  support: "Could we open a ticket about this?",
  sales: "How about one tiny counteroffer?",
};
const EXTRA_LINES = [
  "Wait! I just found my favorite pen!",
  "Can we pencil in a do-over instead?",
  "But I brought extra sticky notes!",
];

/** Fixed local copy: never inspect a coworker's instructions, memory, or conversations. */
export function freshStartLine({ roleId, slug }: { roleId: string; slug: string }): string {
  if (Object.hasOwn(ROLE_LINES, roleId)) return ROLE_LINES[roleId]!;
  let seed = 0;
  for (const character of slug) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
  return EXTRA_LINES[seed % EXTRA_LINES.length]!;
}

/** A small cast should sound like teammates, not three copies of the same line. */
export function freshStartLines(coworkers: { roleId: string; slug: string }[]): string[] {
  const used = new Set<string>();
  return coworkers.map((coworker) => {
    const preferred = freshStartLine(coworker);
    const line = used.has(preferred) ? EXTRA_LINES.find((candidate) => !used.has(candidate)) ?? preferred : preferred;
    used.add(line);
    return line;
  });
}
