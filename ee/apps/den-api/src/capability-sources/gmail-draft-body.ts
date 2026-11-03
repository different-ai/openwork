/** Deliberately bounded email markdown, not a general Markdown/HTML renderer.
 * Both alternatives come from the same parse. Source HTML is always text;
 * only this module's fixed tags/styles and validated links become markup.
 */
export type DraftBody = { plain: string; html: string }

const lineStyle = "white-space:pre-wrap;overflow-wrap:anywhere"
const maxDepth = 16

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Attribute encoding is separate from text encoding; styles stay fixed/allowlisted. */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

function safeUrl(url: string): boolean {
  if (/[\s\x00-\x1f\x7f<>"'\\]/.test(url)) return false
  try {
    const parsed = new URL(url)
    return ((parsed.protocol === "https:" || parsed.protocol === "http:") && Boolean(parsed.hostname))
      || (parsed.protocol === "mailto:" && Boolean(parsed.pathname))
  } catch {
    return false
  }
}

function link(label: DraftBody, url: string): DraftBody {
  return {
    plain: `${label.plain} (${url})`,
    html: safeUrl(url) ? `<a href="${escapeHtmlAttribute(url)}">${label.html}</a>` : `${label.html} (${escapeHtml(url)})`,
  }
}

function inline(text: string, depth = 0, allowLinks = true): DraftBody {
  if (depth >= maxDepth) return { plain: text, html: escapeHtml(text) }
  let plain = ""
  let html = ""
  let index = 0
  const append = (part: DraftBody) => { plain += part.plain; html += part.html }
  while (index < text.length) {
    const rest = text.slice(index)
    const escaped = rest.match(/^\\([\\`*_[\]{}()#+.!|>~-])/)
    if (escaped) {
      append({ plain: escaped[1], html: escapeHtml(escaped[1]) })
      index += escaped[0].length
      continue
    }
    const ticks = rest.match(/^`+/)?.[0]
    if (ticks) {
      let end = rest.indexOf(ticks, ticks.length)
      while (end >= 0 && (rest[end - 1] === "`" || rest[end + ticks.length] === "`")) end = rest.indexOf(ticks, end + ticks.length)
      if (end >= 0) {
        const code = rest.slice(ticks.length, end)
        append({ plain: code, html: `<code>${escapeHtml(code)}</code>` })
        index += end + ticks.length
      } else {
        append({ plain: ticks, html: ticks })
        index += ticks.length
      }
      continue
    }
    const image = rest.match(/^!\[[^\]]*\]\([^)]*\)/)?.[0]
    if (image) {
      append({ plain: image, html: escapeHtml(image) })
      index += image.length
      continue
    }
    // Simple inline links, including balanced parentheses in a URL. Images and
    // reference links are outside the subset and stay literal text.
    const labelEnd = rest.startsWith("[") && allowLinks ? rest.indexOf("](") : -1
    if (labelEnd > 0) {
      let end = labelEnd + 2
      let balance = 1
      for (; end < rest.length; end++) {
        if (rest[end] === "(") balance++
        if (rest[end] === ")" && --balance === 0) break
      }
      if (balance === 0) {
        append(link(inline(rest.slice(1, labelEnd), depth + 1, false), rest.slice(labelEnd + 2, end)))
        index += end + 1
        continue
      }
    }
    const delimiter = rest.startsWith("**") ? "**" : rest.startsWith("__") ? "__" : rest[0]
    if ((delimiter === "*" || delimiter === "_" || delimiter.length === 2)
      && !/\s/.test(rest[delimiter.length] ?? " ")
      && (delimiter[0] !== "_" || !/[\p{L}\p{N}]/u.test(text[index - 1] ?? ""))) {
      let end = rest.indexOf(delimiter, delimiter.length)
      while (end > 0 && (/\s/.test(rest[end - 1]) || (delimiter.length === 1 && rest[end + 1] === delimiter))) {
        end = rest.indexOf(delimiter, end + delimiter.length)
      }
      if (end > delimiter.length) {
        const content = inline(rest.slice(delimiter.length, end), depth + 1, allowLinks)
        const tag = delimiter.length === 2 ? "strong" : "em"
        append({ plain: content.plain, html: `<${tag}>${content.html}</${tag}>` })
        index += end + delimiter.length
        continue
      }
    }
    const bare = allowLinks && (index === 0 || /[\s(]/.test(text[index - 1]))
      ? rest.match(/^(?:https?:\/\/|mailto:)[^\s<>"']+/i)?.[0] : undefined
    if (bare) {
      let url = bare.replace(/[.,;:!?]+$/, "")
      while (url.endsWith(")") && url.split(")").length > url.split("(").length) url = url.slice(0, -1)
      if (safeUrl(url)) {
        append({ plain: url, html: `<a href="${escapeHtmlAttribute(url)}">${escapeHtml(url)}</a>` })
        index += url.length
        continue
      }
    }
    append({ plain: rest[0], html: escapeHtml(rest[0]) })
    index++
  }
  return { plain, html }
}

function line(content: DraftBody): string {
  return content.html.length === 0 ? "<div><br></div>" : `<div dir="ltr" style="${escapeHtmlAttribute(lineStyle)}">${content.html}</div>`
}

function listItem(text: string): { indent: number; prefix: string; ordered: boolean; number: number; text: string } | null {
  const match = text.match(/^([ \t]*)([-*]|\d+\.)[ \t]+(.*)$/)
  return match ? { indent: match[1].replace(/\t/g, "    ").length, prefix: `${match[1]}${match[2]} `, ordered: match[2].endsWith("."), number: parseInt(match[2], 10), text: match[3] } : null
}

function cells(text: string): string[] {
  const result: string[] = []
  let cell = ""
  let codeTicks = 0
  const source = text.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "")
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\\" && index + 1 < source.length) {
      cell += source[index] + source[++index]
    } else if (source[index] === "`") {
      const ticks = source.slice(index).match(/^`+/)![0].length
      if (codeTicks === 0) codeTicks = ticks
      else if (codeTicks === ticks) codeTicks = 0
      cell += "`".repeat(ticks)
      index += ticks - 1
    } else if (source[index] === "|" && codeTicks === 0) {
      result.push(cell.trim()); cell = ""
    } else cell += source[index]
  }
  result.push(cell.trim())
  return result
}

/** Prose normalization is applied only outside structured blocks/code. */
export function renderGmailDraftBody(body: string, normalizeProse: (text: string) => string): DraftBody {
  return blocks(body.replace(/\r\n?/g, "\n").split("\n"), normalizeProse, 0)
}

function blocks(lines: string[], normalizeProse: (text: string) => string, depth: number): DraftBody {
  const plain: string[] = []
  const html: string[] = []
  let index = 0
  const fenceAt = (n: number) => lines[n]?.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
  const quoteAt = (n: number) => /^ {0,3}>/.test(lines[n] ?? "")
  const headingAt = (n: number) => lines[n]?.match(/^ {0,3}#{1,6}\s+(.*)$/)
  function tableAt(n: number): { headers: string[]; alignments: string[] } | null {
    if (!lines[n]?.includes("|") || !lines[n + 1]?.includes("|")) return null
    const headers = cells(lines[n])
    const delimiters = cells(lines[n + 1])
    return headers.length === delimiters.length && delimiters.every(cell => /^:?-{3,}:?$/.test(cell))
      ? { headers, alignments: delimiters.map(cell => cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : "left") } : null
  }
  function list(indent: number, nesting: number): DraftBody {
    const first = listItem(lines[index])!
    const tag = first.ordered ? "ol" : "ul"
    const items: string[] = []
    const text: string[] = []
    while (index < lines.length) {
      const item = listItem(lines[index])
      if (!item || item.indent !== indent || item.ordered !== first.ordered) break
      const content = inline(item.text)
      let itemHtml = content.html
      // Keep authored markers/numbers and indentation; normalize only the marker separator.
      text.push(item.prefix + content.plain)
      index++
      while (index < lines.length && lines[index].trim() !== "") {
        const child = listItem(lines[index])
        if (child) {
          if (child.indent <= indent || nesting >= maxDepth) break
          const nested = list(child.indent, nesting + 1)
          itemHtml += nested.html
          text.push(nested.plain)
        } else {
          const leading = lines[index].match(/^[ \t]*/)![0].replace(/\t/g, "    ").length
          if (leading <= indent) break
          const continuation = inline(lines[index])
          text.push(continuation.plain)
          itemHtml += line(continuation)
          index++
        }
      }
      items.push(`<li style="${escapeHtmlAttribute(lineStyle)}">${itemHtml}</li>`)
    }
    const start = first.ordered && first.number !== 1 ? ` start="${escapeHtmlAttribute(String(first.number))}"` : ""
    return { plain: text.join("\n"), html: `<${tag}${start} dir="ltr" style="margin:0;padding-left:2em">${items.join("")}</${tag}>` }
  }
  while (index < lines.length) {
    const fence = fenceAt(index)
    if (fence) {
      const code: string[] = []
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`)
      index++
      while (index < lines.length && !close.test(lines[index])) code.push(lines[index++])
      if (index < lines.length) index++
      const text = code.join("\n")
      plain.push(text)
      html.push(`<pre dir="ltr" style="${escapeHtmlAttribute(`${lineStyle};margin:0;font-family:monospace`)}">${escapeHtml(text)}</pre>`)
      continue
    }
    if (quoteAt(index) && depth < maxDepth) {
      const quoted: string[] = []
      while (index < lines.length && quoteAt(index)) quoted.push(lines[index++].replace(/^ {0,3}> ?/, ""))
      const content = blocks(quoted, normalizeProse, depth + 1)
      plain.push(content.plain.split("\n").map(text => `> ${text}`).join("\n"))
      html.push(`<blockquote dir="ltr" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${content.html}</blockquote>`)
      continue
    }
    if (listItem(lines[index])) {
      const content = list(listItem(lines[index])!.indent, 0)
      plain.push(content.plain); html.push(content.html)
      continue
    }
    const table = tableAt(index)
    if (table) {
      const rows = [table.headers.map(cell => inline(cell))]
      index += 2
      while (index < lines.length && lines[index].includes("|")) {
        const row = cells(lines[index])
        if (row.length !== table.headers.length) break
        rows.push(row.map(cell => inline(cell)))
        index++
      }
      const widths = table.headers.map((_, column) => Math.max(3, ...rows.map(row => row[column].plain.length)))
      // Avoid quadratic padding amplification for very wide/sparse tables.
      // Normal email tables align; oversized tables retain every cell unpadded.
      const paddedSize = (widths.reduce((sum, width) => sum + width + 3, 1)) * (rows.length + 1)
      const padding = paddedSize <= 1_000_000 ? widths : widths.map(() => 0)
      const textRows = rows.map(row => `| ${row.map((cell, column) => cell.plain.padEnd(padding[column])).join(" | ")} |`)
      textRows.splice(1, 0, `| ${padding.map(width => "-".repeat(Math.max(3, width))).join(" | ")} |`)
      plain.push(textRows.join("\n"))
      html.push(`<div dir="ltr"><table style="border-collapse:collapse">${rows.map((row, rowIndex) => `<tr>${row.map((cell, column) => {
        const tag = rowIndex === 0 ? "th" : "td"
        return `<${tag} style="${escapeHtmlAttribute(`border:1px solid #dadce0;padding:4px 8px;text-align:${table.alignments[column]};${lineStyle}`)}">${cell.html}</${tag}>`
      }).join("")}</tr>`).join("")}</table></div>`)
      continue
    }
    const heading = headingAt(index)
    if (heading) {
      const content = inline(heading[1])
      plain.push(content.plain); html.push(line({ ...content, html: `<strong>${content.html}</strong>` }))
      index++
      continue
    }
    if (lines[index] === "") {
      plain.push(""); html.push("<div><br></div>"); index++
      continue
    }
    const prose = [lines[index++]]
    while (index < lines.length && lines[index] !== "" && !fenceAt(index) && !quoteAt(index)
      && !headingAt(index) && !listItem(lines[index]) && !tableAt(index)) prose.push(lines[index++])
    for (const text of normalizeProse(prose.join("\n")).split("\n")) {
      const content = inline(text)
      plain.push(content.plain); html.push(line(content))
    }
  }
  return { plain: plain.join("\n"), html: html.join("") }
}
