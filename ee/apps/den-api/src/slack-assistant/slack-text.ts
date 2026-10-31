/**
 * Text the Slack bot posts: model and desktop answers are written in standard Markdown, but `text` fields and
 * `mrkdwn` blocks use Slack's own format (`*bold*`, `<url|label>`), and every Slack text field has a size limit.
 * Pure functions, shared by every bot reply path.
 */

/** Slack's limit for the text of one section block. */
export const SECTION_TEXT_LIMIT = 3_000

/**
 * Model and desktop text is untrusted. Escaping `&`, `<` and `>` turns Slack's
 * control sequences (`<@U…>`, `<!here>`, `<!subteam^…>`, `<https://…|label>`)
 * into plain text, and a zero-width space keeps `@here`, `@channel` and
 * `@everyone` from ever being read as a broadcast.
 */
export function slackSafeText(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/@(here|channel|everyone)\b/gi, "@\u200b$1")
}

/** Drops emphasis and inline-code markers a cut left without a partner, and closes a code block it left open. */
function balanceFormatting(text: string, ending = "") {
  let out = text
  if ((out.match(/```/g) ?? []).length % 2 === 1) return `${out}${ending}\n\`\`\``
  for (const marker of ["**", "__", "~~"]) {
    if (out.split(marker).length % 2 === 0) {
      const last = out.lastIndexOf(marker)
      out = `${out.slice(0, last)}${out.slice(last + marker.length)}`
    }
  }
  if ((out.match(/`/g) ?? []).length % 2 === 1) {
    const last = out.lastIndexOf("`")
    out = `${out.slice(0, last)}${out.slice(last + 1)}`
  }
  return `${out}${ending}`
}

/**
 * A short version of `text` for a notification or one-line reason: ends at a sentence when one is close to the
 * limit, otherwise at a word, and never leaves formatting open.
 */
export function excerpt(text: string, limit: number) {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  const cut = trimmed.slice(0, limit)
  const sentenceEnd = lastMatchEnd(cut, /[.!?](?=\s)/g)
  if (sentenceEnd > limit * 0.5) return balanceFormatting(cut.slice(0, sentenceEnd))
  const boundary = cut.lastIndexOf(" ")
  return balanceFormatting((boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd(), "…")
}

function lastMatchEnd(text: string, pattern: RegExp) {
  let end = -1
  for (const match of text.matchAll(pattern)) end = (match.index ?? 0) + match[0].length
  return end
}

// Placeholders for pieces of a line that are already final (links, code): private-use characters never typed by people.
const TOKEN_OPEN = "\uE000"
const TOKEN_CLOSE = "\uE001"
const BOLD = "\uE002"
const PRIVATE_USE = /[\uE000-\uE002]/g

function escapeUrl(url: string) {
  return url.replaceAll("&", "&amp;").replaceAll("|", "%7C")
}

function linkable(url: string) {
  return /^(https?:\/\/|mailto:)[^\s<>]+$/i.test(url)
}

/** A link label: plain text, since Slack shows formatting inside `<url|label>` inconsistently. */
function linkLabel(label: string) {
  return slackSafeText(label.replace(/\*\*|__|~~|`/g, "").replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1").trim())
}

/** Splits a bare URL from punctuation that ends the sentence around it. */
function trimUrl(raw: string) {
  let url = raw
  while (/[.,;:!?'"*_~)\]]$/.test(url)) {
    if (url.endsWith(")") && (url.match(/\(/g) ?? []).length >= (url.match(/\)/g) ?? []).length) break
    url = url.slice(0, -1)
  }
  return { url, rest: raw.slice(url.length) }
}

/** Converts the inline Markdown of one line (no block syntax) to escaped Slack mrkdwn. */
function inlineMrkdwn(source: string) {
  const tokens: string[] = []
  const token = (value: string) => `${TOKEN_OPEN}${tokens.push(value) - 1}${TOKEN_CLOSE}`
  let text = source.replace(PRIVATE_USE, "")

  // Code spans are literal: escaped, never formatted.
  text = text.replace(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (_, _ticks: string, code: string) =>
    token(`\`${slackSafeText(code.trim().replaceAll("`", "'"))}\``),
  )
  // [label](url), [label](<url>), ![alt](url) and [label](url "title").
  text = text.replace(
    /!?\[((?:[^[\]\n]|\[[^\]\n]*\])*)\]\(\s*(?:<([^<>\n]*)>|([^\s()<>]+(?:\([^\s()<>]*\)[^\s()<>]*)*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g,
    (whole, label: string, bracketed: string | undefined, plain: string | undefined) => {
      const url = (bracketed ?? plain ?? "").trim()
      const shown = linkLabel(label)
      if (!linkable(url)) return token(shown && shown !== slackSafeText(url) ? `${shown} (${slackSafeText(url)})` : slackSafeText(url || whole))
      return token(shown && shown !== url ? `<${escapeUrl(url)}|${shown}>` : `<${escapeUrl(url)}>`)
    },
  )
  // <https://…> autolinks.
  text = text.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_, url: string) => token(`<${escapeUrl(url)}>`))
  // Bare URLs are linked explicitly, so Slack never folds a following `**` or `)` into the link.
  text = text.replace(/\bhttps?:\/\/[^\s<>]+/gi, (raw: string) => {
    const { url, rest } = trimUrl(raw)
    return `${token(`<${escapeUrl(url)}>`)}${rest}`
  })

  text = slackSafeText(text)
  text = text
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, `${BOLD}$1${BOLD}`)
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~")
    .replace(/(?<![*\p{L}\p{N}])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\p{L}\p{N}])/gu, "_$1_")
    // A `**` without a partner (a cut, or a typo) would show as literal asterisks.
    .replaceAll("**", "")
    .replaceAll(BOLD, "*")
  return text.replace(new RegExp(`${TOKEN_OPEN}(\\d+)${TOKEN_CLOSE}`, "g"), (_, index: string) => tokens[Number(index)] ?? "")
}

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function blockLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)
  if (heading) {
    const title = inlineMrkdwn((heading[1] ?? "").replace(/\*\*|__/g, ""))
    return title ? `*${title}*` : ""
  }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return "───"
  const quote = /^\s{0,3}>\s?(.*)$/.exec(line)
  if (quote) return `> ${blockLine(quote[1] ?? "")}`.trimEnd()
  const bullet = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line)
  if (bullet) {
    const depth = Math.floor((bullet[1] ?? "").replaceAll("\t", "  ").length / 2)
    const marker = bullet[2] === undefined ? (depth ? "◦" : "•") : bullet[2] === " " ? "☐" : "☑"
    return `${"    ".repeat(depth)}${marker} ${inlineMrkdwn(bullet[3] ?? "")}`
  }
  const numbered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line)
  if (numbered) {
    const depth = Math.floor((numbered[1] ?? "").replaceAll("\t", "  ").length / 2)
    return `${"    ".repeat(depth)}${numbered[2]}. ${inlineMrkdwn(numbered[3] ?? "")}`
  }
  return inlineMrkdwn(line.replace(/\s+$/, ""))
}

/**
 * Converts standard (GitHub) Markdown to Slack mrkdwn: bold, italics, strikethrough, links, headings, lists,
 * quotes, inline code and code blocks. Tables become code blocks so their columns stay aligned. The result is
 * escaped: nothing in `markdown` can mention, broadcast or inject a Slack control sequence.
 */
export function markdownToMrkdwn(markdown: string) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let fence: string | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const fenceLine = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence !== null) {
      if (fenceLine && fenceLine[1]?.[0] === fence[0] && (fenceLine[1]?.length ?? 0) >= fence.length && !fenceLine[2]?.trim()) {
        out.push("```")
        fence = null
      } else out.push(slackSafeText(line.replaceAll("```", "ˋˋˋ")))
      continue
    }
    if (fenceLine && !(fenceLine[1]?.startsWith("`") && fenceLine[2]?.includes("`"))) {
      fence = fenceLine[1] ?? "```"
      out.push("```")
      continue
    }
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[index + 1] ?? "")) {
      out.push("```")
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? "")) {
        out.push(slackSafeText((lines[index] ?? "").trim().replace(/\*\*|__|`/g, "")))
        index++
      }
      index--
      out.push("```")
      continue
    }
    out.push(blockLine(line))
  }
  if (fence !== null) out.push("```")
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Plain text for notifications and screen readers: no formatting markers, links shown by their label. */
export function markdownToPlainText(markdown: string) {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^\s{0,3}(`{3,}|~{3,}).*$/gm, "")
    .replace(/!?\[((?:[^[\]\n]|\[[^\]\n]*\])*)\]\([^)\n]*\)/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(?<![*\p{L}\p{N}])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\p{L}\p{N}])/gu, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Whether a cut at the end of `segment` (the current line up to the cut) leaves no inline span open. */
function inlineClosed(segment: string) {
  if ((segment.match(/`/g) ?? []).length % 2 === 1) return false
  const outsideCode = segment.replace(/`[^`]*`/g, "")
  const count = (pattern: RegExp) => (outsideCode.match(pattern) ?? []).length
  return (
    count(/</g) === count(/>/g) &&
    count(/\[/g) === count(/\]/g) &&
    count(/\(/g) === count(/\)/g) &&
    count(/\*/g) % 2 === 0 &&
    count(/~/g) % 2 === 0
  )
}

/** Where to end a part of at most `budget` characters: a paragraph, a line, a sentence, a word, in that order. */
function splitPoint(text: string, budget: number) {
  const paragraph = text.lastIndexOf("\n\n", budget)
  if (paragraph > budget * 0.5) return paragraph
  const line = text.lastIndexOf("\n", budget)
  if (line > budget * 0.5) return line
  const lineStart = Math.max(0, line + 1)
  const closedAt = (end: number) => inlineClosed(text.slice(lineStart, end))
  const window = text.slice(0, budget)
  const sentences = [...window.matchAll(/[.!?](?=\s)/g)].map((match) => (match.index ?? 0) + 1).filter((end) => end > budget * 0.3)
  const sentence = sentences.reverse().find(closedAt)
  if (sentence !== undefined) return sentence
  const words = [...window.matchAll(/ (?=\S)/g)].map((match) => match.index ?? 0).filter((end) => end > budget * 0.3)
  const word = words.reverse().find(closedAt) ?? words[0]
  if (word !== undefined) return word
  // One unbroken run of text: never split inside a link.
  const openLink = window.lastIndexOf("<")
  return openLink > window.lastIndexOf(">") && openLink > 0 ? openLink : budget
}

/**
 * Splits text into parts of at most `limit` characters without losing any of it: at paragraph breaks first, then
 * lines, sentences and words, never inside a link or a formatted span when that can be helped. A code block the
 * split runs through is closed at the end of one part and reopened at the start of the next.
 */
export function splitSlackText(text: string, limit: number) {
  const parts: string[] = []
  let rest = text.trim()
  let reopen = ""
  while (rest) {
    const body = `${reopen}${rest}`
    if (body.length <= limit) {
      parts.push(body)
      break
    }
    // Room to close a code block the cut leaves open.
    const budget = limit - 4
    const cut = Math.max(reopen.length + 1, splitPoint(body, budget))
    let head = body.slice(0, cut).trimEnd()
    rest = body.slice(cut).replace(/^\n+/, "").replace(/^ /, "")
    const fences = [...head.matchAll(/^[ \t]*(```.*)$/gm)]
    if (fences.length % 2 === 1) {
      head += "\n```"
      reopen = `${fences.at(-1)?.[1]?.trim() ?? "```"}\n`
    } else reopen = ""
    parts.push(head)
  }
  return parts.filter((part) => part.trim())
}
