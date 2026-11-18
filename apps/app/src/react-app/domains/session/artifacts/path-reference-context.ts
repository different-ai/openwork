import { parseLocalPathReference, type LocalPathReference } from "./local-path";
import type { OpenTarget } from "./open-target";

/** Only an explicitly written directory (ending in a separator) supplies a base.
 * Never infer a directory from English prose, a filename's extension, or later text.
 * This keeps context language-independent and prevents another list below this one
 * from changing the meaning of an earlier link.
 */
export function directoryReference(value: string, decode = false): string | null {
  const trimmed = value.trim();
  if (!/[/\\]$/.test(trimmed)) return null;
  const reference = parseLocalPathReference(`${trimmed}__openwork_directory__`, { decode });
  return reference ? reference.path.slice(0, -"__openwork_directory__".length) : null;
}

/** The clicked node's preceding inline paths, in document order. Fenced examples
 * and listed child directories are not base declarations. Both streamed blocks and settled messages use
 * the same DOM order, including repeated filenames in different directory lists.
 */
export function precedingDirectory(root: HTMLElement, node: Element): string | null {
  let directory: string | null = null;
  for (const element of root.querySelectorAll("code, a[data-openwork-link-href], [data-openwork-directory-path]")) {
    if (element === node || element.contains(node)) break;
    if (!(element.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (element.closest("pre")) continue;
    // A directory listed among the outputs (`scenes/`) is a child, not a new
    // declaration of where the following sibling files live.
    if (element.closest("li")) continue;
    const value = element instanceof HTMLElement ? element.dataset.openworkDirectoryPath ?? element.dataset.openworkLinkHref ?? element.textContent ?? "" : "";
    const candidate = directoryReference(value, element.hasAttribute("data-openwork-link-href"));
    if (candidate) directory = candidate;
  }
  return directory;
}

/** Context adds candidates, never a verified identity. The owning runtime checks
 * each exact candidate before the original reference's bounded workspace search.
 * Absolute/home paths and already scoped files are never reinterpreted by suffix.
 */
export function contextualizeFileTarget(target: OpenTarget, directory: string | null): OpenTarget {
  const reference = parseLocalPathReference(target.value);
  if (target.kind !== "file" || target.fileScope || target.resolvedPath || !reference || reference.anchor !== "relative" || !directory) return target;
  const value = parseLocalPathReference(`${directory}${reference.path}`)?.path;
  return value ? { ...target, pathHints: [value] } : target;
}

/** Reuse actual session file identities (including tool-produced targets), not
 * arbitrary prose matches. A partial name is only evidence for a matching suffix.
 * Ambiguous evidence is deliberately ignored rather than picking the first file.
 */
export function sessionFileCandidate(reference: LocalPathReference, targets: OpenTarget[]): OpenTarget | null {
  if (reference.anchor !== "relative") return null;
  const suffix = reference.path.replace(/\\/g, "/");
  const matches = new Map<string, OpenTarget>();
  for (const target of targets) {
    if (target.kind !== "file") continue;
    const value = target.resolvedPath ?? target.value;
    const parsed = parseLocalPathReference(value);
    if (!parsed) continue;
    const normalized = parsed.path.replace(/\\/g, "/");
    if (normalized !== suffix && !normalized.endsWith(`/${suffix}`)) continue;
    // A bare unverified mention is not additional location evidence.
    if (normalized === suffix && !target.fileScope && !target.resolvedPath) continue;
    matches.set(`${target.fileScope ?? ""}:${normalized}`, target);
  }
  return matches.size === 1 ? matches.values().next().value ?? null : null;
}
