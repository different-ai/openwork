import { parseLocalPathReference, type LocalPathReference } from "./local-path";
import type { OpenTarget } from "./open-target";

export function directoryReference(value: string, decode = false): string | null {
  const trimmed = value.trim();
  if (!/[/\\]$/.test(trimmed)) return null;
  const reference = parseLocalPathReference(`${trimmed}__openwork_directory__`, { decode });
  return reference ? reference.path.slice(0, -"__openwork_directory__".length) : null;
}

export function precedingDirectory(root: HTMLElement, node: Element): string | null {
  let directory: string | null = null;
  for (const element of root.querySelectorAll("code, a[data-openwork-link-href], [data-openwork-directory-path]")) {
    if (element === node || element.contains(node)) break;
    if (!(element.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (element.closest("pre")) continue;
    if (element.closest("li")) continue;
    const value = element instanceof HTMLElement ? element.dataset.openworkDirectoryPath ?? element.dataset.openworkLinkHref ?? element.textContent ?? "" : "";
    const candidate = directoryReference(value, element.hasAttribute("data-openwork-link-href"));
    if (candidate) directory = candidate;
  }
  return directory;
}

export function contextualizeFileTarget(target: OpenTarget, directory: string | null): OpenTarget {
  const reference = parseLocalPathReference(target.value);
  if (target.kind !== "file" || target.fileScope || target.resolvedPath || !reference || reference.anchor !== "relative" || !directory) return target;
  const value = parseLocalPathReference(`${directory}${reference.path}`)?.path;
  return value ? { ...target, pathHints: [value] } : target;
}

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
    if (normalized === suffix && !target.fileScope && !target.resolvedPath) continue;
    matches.set(`${target.fileScope ?? ""}:${normalized}`, target);
  }
  return matches.size === 1 ? matches.values().next().value ?? null : null;
}
