import { t } from "@/i18n"
import { parseGitHubReference, type GitHubReference } from "@/lib/text-activity"

/**
 * GitHub pull request and issue links in assistant Markdown carry their own
 * mark (DESIGN.md V5): the pull request or issue glyph inline before the
 * link text. The transcript does not know their state, so the mark stays
 * neutral; nothing is fetched. A bare URL reads as `repo#123`.
 * Text-first rail only (flag `textActivityRail`).
 */

const SVG_NS = "http://www.w3.org/2000/svg"

// Octicons (MIT): git-pull-request-16 and issue-opened-16.
const GLYPHS: Record<GitHubReference["kind"], string[]> = {
  pull: [
    "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  ],
  issue: [
    "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
    "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  ],
}

function glyph(kind: GitHubReference["kind"]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("width", "14")
  svg.setAttribute("height", "14")
  svg.setAttribute("fill", "currentColor")
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("data-github-reference-glyph", kind)
  svg.setAttribute("class", "me-1 inline-block shrink-0 align-[-2px] text-muted-foreground")
  for (const d of GLYPHS[kind]) {
    const path = document.createElementNS(SVG_NS, "path")
    path.setAttribute("d", d)
    svg.append(path)
  }
  return svg
}

/** Decorate every GitHub pull request or issue link under `root`. Safe to call repeatedly. */
export function decorateGitHubReferences(root: HTMLElement): void {
  for (const link of root.querySelectorAll("a[href]")) {
    if (!(link instanceof HTMLAnchorElement) || link.dataset.githubReference) continue
    const href = link.getAttribute("href") ?? ""
    const reference = parseGitHubReference(href)
    if (!reference) continue
    link.dataset.githubReference = reference.kind
    // GitHub's own mark replaces the generic site favicon.
    for (const favicon of link.querySelectorAll("img[aria-hidden='true']")) favicon.remove()
    const label = (link.textContent ?? "").trim()
    if (!label || label === href || label === href.replace(/^https?:\/\//, "")) {
      link.textContent = `${reference.repo}#${reference.number}`
    }
    link.setAttribute("aria-label", `${t(reference.kind === "pull" ? "text_activity.github_pull" : "text_activity.github_issue")} ${link.textContent ?? ""}`.trim())
    link.prepend(glyph(reference.kind))
  }
}
