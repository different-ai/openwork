/**
 * What a reply points at, so it can be shown the way a messaging app shows a
 * shared link: the coworker's own documents it names, and web links it shares.
 * Pure, so the bubble's inline links and the preview cards agree.
 */
export type DocumentReference = { id: string; title: string; summary: string; highlights: string[]; words?: number; updatedAt?: number };

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const linkTo = (document: DocumentReference) => `[${document.title.replace(/[[\]]/g, "")}](doc:${document.id})`;

/** Documents the reply names, in order of first mention: a doc: link, its id in code, or its title in bold. */
export function mentionedDocuments(text: string, documents: readonly DocumentReference[]): DocumentReference[] {
  const found: { at: number; document: DocumentReference }[] = [];
  for (const document of documents) {
    const patterns = [`\\(doc:${escape(document.id)}\\)`, `\`${escape(document.id)}\``];
    if (document.title.trim()) patterns.push(`\\*\\*${escape(document.title.trim())}\\*\\*`);
    const match = new RegExp(patterns.join("|"), "i").exec(text);
    if (match) found.push({ at: match.index, document });
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.document);
}

/**
 * The reply with each document it names turned into a doc: link, so the name
 * opens the document in place. "**Title** (`id`)" collapses to one linked title.
 */
export function linkDocumentMentions(text: string, documents: readonly DocumentReference[]): string {
  let linked = text;
  for (const document of documents) {
    const id = escape(document.id);
    const title = document.title.trim() ? escape(document.title.trim()) : null;
    if (title) linked = linked.replace(new RegExp(`\\*\\*${title}\\*\\*\\s*\\(\\s*\`${id}\`\\s*\\)`, "gi"), `**${linkTo(document)}**`);
    linked = linked.replace(new RegExp(`\`${id}\``, "g"), linkTo(document));
    if (title) linked = linked.replace(new RegExp(`\\*\\*${title}\\*\\*`, "gi"), `**${linkTo(document)}**`);
  }
  return linked;
}

/** Web links shared in the reply, in order, each once, at most `limit`. */
export function sharedLinks(text: string, limit = 2): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>()[\]"'`]+/gi)) {
    const url = match[0].replace(/[.,;:!?*_~]+$/, "");
    if (!links.includes(url)) links.push(url);
    if (links.length >= limit) break;
  }
  return links;
}
