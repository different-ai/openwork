// Block Kit for the workshop Slack ("Open Slack"): checks the blocks an app posts against the limits Slack documents,
// and draws the ones OpenWork sends. A payload Slack would refuse is refused here with Slack's error name, so an app
// that only ever met this sandbox still finds out. This is a stand-in drawn from the reference, not Slack's renderer.
//
//   https://docs.slack.dev/reference/block-kit/blocks                    50 blocks per message
//   https://docs.slack.dev/reference/block-kit/blocks/header-block       plain_text, 150 characters
//   https://docs.slack.dev/reference/block-kit/blocks/section-block      text 3,000; 10 fields of 2,000
//   https://docs.slack.dev/reference/block-kit/blocks/context-block      10 elements
//   https://docs.slack.dev/reference/block-kit/blocks/markdown-block     12,000 characters across the payload
//   https://docs.slack.dev/reference/block-kit/blocks/table-block        100 rows, 20 cells a row, 10,000 characters a message
//   https://docs.slack.dev/reference/block-kit/blocks/image-block        url 3,000; alt text and title 2,000
//   https://docs.slack.dev/reference/block-kit/blocks/actions-block      25 elements
//   https://docs.slack.dev/reference/block-kit/block-elements/button-element   text 75, action_id 255, url 3,000, value 2,000
import { escapeHtml } from "./workshop-html.mjs";

export const BLOCK_LIMITS = { blocks: 50, header: 150, sectionText: 3000, fields: 10, fieldText: 2000, contextElements: 10, text: 3000, markdown: 12000, tableRows: 100, tableCells: 20, tableCharacters: 10000, imageUrl: 3000, imageAlt: 2000, imageTitle: 2000, actions: 25, buttonText: 75, actionId: 255, buttonUrl: 3000, buttonValue: 2000, blockId: 255, contextActions: 5 };

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isText = (value, max, types = ["plain_text", "mrkdwn"]) => isObject(value) && types.includes(value.type) && typeof value.text === "string" && value.text.length >= 1 && value.text.length <= max;
const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const httpUrl = (value, max) => typeof value === "string" && value.length <= max && /^https?:\/\/[^\s<>"]+$/i.test(value);

function buttonOk(element) {
  if (!isObject(element) || element.type !== "button" || !only(element, ["type", "text", "action_id", "url", "value", "style", "accessibility_label"])) return false;
  if (!isText(element.text, BLOCK_LIMITS.buttonText, ["plain_text"])) return false;
  if (element.action_id !== undefined && (typeof element.action_id !== "string" || !element.action_id || element.action_id.length > BLOCK_LIMITS.actionId)) return false;
  if (element.url !== undefined && !httpUrl(element.url, BLOCK_LIMITS.buttonUrl)) return false;
  if (element.value !== undefined && (typeof element.value !== "string" || element.value.length > BLOCK_LIMITS.buttonValue)) return false;
  return element.style === undefined || element.style === "primary" || element.style === "danger";
}

function cellText(cell) {
  if (!isObject(cell)) return null;
  if (cell.type === "raw_text") return typeof cell.text === "string" && cell.text.length >= 1 && only(cell, ["type", "text"]) ? cell.text : null;
  if (cell.type !== "rich_text" || !Array.isArray(cell.elements) || !cell.elements.length) return null;
  let text = "";
  for (const section of cell.elements) {
    if (!isObject(section) || section.type !== "rich_text_section" || !Array.isArray(section.elements)) return null;
    for (const element of section.elements) {
      if (!isObject(element) || typeof element.text !== "string" || !element.text) return null;
      if (element.type === "link" ? !httpUrl(element.url, 3000) : element.type !== "text") return null;
      text += element.text;
    }
  }
  return text || null;
}

/** Answers Slack's error name for a `blocks` argument Slack would refuse, or null when it is acceptable. */
export function blocksError(blocks) {
  if (!Array.isArray(blocks)) return "invalid_blocks_format";
  if (blocks.length > BLOCK_LIMITS.blocks) return "invalid_blocks";
  let markdown = 0, tableCharacters = 0;
  for (const block of blocks) {
    if (!isObject(block) || typeof block.type !== "string") return "invalid_blocks_format";
    if (block.block_id !== undefined && (typeof block.block_id !== "string" || block.block_id.length > BLOCK_LIMITS.blockId)) return "invalid_blocks";
    switch (block.type) {
      case "header":
        if (!only(block, ["type", "text", "block_id", "level"]) || !isText(block.text, BLOCK_LIMITS.header, ["plain_text"])) return "invalid_blocks";
        break;
      case "divider":
        if (!only(block, ["type", "block_id"])) return "invalid_blocks";
        break;
      case "section": {
        if (!only(block, ["type", "text", "fields", "block_id", "expand"])) return "invalid_blocks";
        if (block.text === undefined && block.fields === undefined) return "invalid_blocks";
        if (block.text !== undefined && !isText(block.text, BLOCK_LIMITS.sectionText)) return "invalid_blocks";
        if (block.fields !== undefined && (!Array.isArray(block.fields) || !block.fields.length || block.fields.length > BLOCK_LIMITS.fields || !block.fields.every((field) => isText(field, BLOCK_LIMITS.fieldText)))) return "invalid_blocks";
        break;
      }
      case "context":
        if (!only(block, ["type", "elements", "block_id"]) || !Array.isArray(block.elements) || !block.elements.length || block.elements.length > BLOCK_LIMITS.contextElements || !block.elements.every((element) => isText(element, BLOCK_LIMITS.text))) return "invalid_blocks";
        break;
      case "markdown":
        if (!only(block, ["type", "text", "block_id"]) || typeof block.text !== "string" || !block.text) return "invalid_blocks";
        markdown += block.text.length;
        break;
      case "table": {
        if (!only(block, ["type", "rows", "column_settings", "block_id"]) || !Array.isArray(block.rows) || !block.rows.length || block.rows.length > BLOCK_LIMITS.tableRows) return "invalid_blocks";
        for (const row of block.rows) {
          if (!Array.isArray(row) || !row.length || row.length > BLOCK_LIMITS.tableCells) return "invalid_blocks";
          for (const cell of row) {
            const text = cellText(cell);
            if (text === null) return "invalid_blocks";
            tableCharacters += text.length;
          }
        }
        const settings = block.column_settings;
        if (settings !== undefined && (!Array.isArray(settings) || settings.length > BLOCK_LIMITS.tableCells || !settings.every((entry) => entry === null || (isObject(entry) && only(entry, ["align", "is_wrapped"]) && (entry.align === undefined || ["left", "center", "right"].includes(entry.align)) && (entry.is_wrapped === undefined || typeof entry.is_wrapped === "boolean"))))) return "invalid_blocks";
        break;
      }
      case "image":
        if (!only(block, ["type", "image_url", "alt_text", "title", "block_id"]) || !httpUrl(block.image_url, BLOCK_LIMITS.imageUrl) || typeof block.alt_text !== "string" || !block.alt_text || block.alt_text.length > BLOCK_LIMITS.imageAlt) return "invalid_blocks";
        if (block.title !== undefined && !isText(block.title, BLOCK_LIMITS.imageTitle, ["plain_text"])) return "invalid_blocks";
        break;
      case "actions": {
        if (!only(block, ["type", "elements", "block_id"]) || !Array.isArray(block.elements) || !block.elements.length || block.elements.length > BLOCK_LIMITS.actions || !block.elements.every(buttonOk)) return "invalid_blocks";
        const ids = block.elements.map((element) => element.action_id).filter((id) => id !== undefined);
        if (new Set(ids).size !== ids.length) return "invalid_blocks";
        break;
      }
      case "context_actions":
        if (!only(block, ["type", "elements", "block_id"]) || !Array.isArray(block.elements) || !block.elements.length || block.elements.length > BLOCK_LIMITS.contextActions || !block.elements.every((element) => isObject(element) && element.type === "feedback_buttons" && isObject(element.positive_button) && isObject(element.negative_button))) return "invalid_blocks";
        break;
      default:
        return "invalid_blocks";
    }
  }
  if (markdown > BLOCK_LIMITS.markdown || tableCharacters > BLOCK_LIMITS.tableCharacters) return "msg_blocks_too_long";
  return null;
}

function inlineMarkdown(source) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let html = escapeHtml(source);
  html = html.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${code}</code>`));
  html = html.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => hold(`<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`));
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>").replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  html = html.replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=$|[\s.,!?:;)])/g, "$1<em>$2</em>").replace(/(^|[\s(])_([^_\s][^_\n]*)_(?=$|[\s.,!?:;)])/g, "$1<em>$2</em>");
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => held[Number(index)]);
}

const TABLE_ROW = /^\s*\|.*\|\s*$/, TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

/** Standard Markdown as HTML, for the markdown block: the text is escaped first and only the tags written here are added. */
export function renderMarkdown(text) {
  const lines = String(text).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let paragraph = [], list = null;
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.tag}>`);
    paragraph = []; list = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      let end = index + 1;
      while (end < lines.length && !lines[end].trim().startsWith(fence[1])) end++;
      out.push(`<pre><code>${escapeHtml(lines.slice(index + 1, end).join("\n"))}</code></pre>`);
      index = end;
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] || "")) {
      flush();
      let end = index + 2;
      while (end < lines.length && TABLE_ROW.test(lines[end])) end++;
      const head = cells(line).map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("");
      const body = lines.slice(index + 2, end).map((row) => `<tr>${cells(row).map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="bk-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      index = end - 1;
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    const item = /^\s*(?:([-*+])|(\d{1,9})[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (heading) { flush(); out.push(`<p class="md-heading"><strong>${inlineMarkdown(heading[1])}</strong></p>`); }
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push("<hr>"); }
    else if (/^\s{0,3}>/.test(line)) { flush(); out.push(`<blockquote>${inlineMarkdown(line.replace(/^\s{0,3}>\s?/, ""))}</blockquote>`); }
    else if (item) {
      const tag = item[1] ? "ul" : "ol";
      if (paragraph.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(`${item[3] === undefined ? "" : item[3] === " " ? "☐ " : "☑ "}${inlineMarkdown(item[4])}`);
    }
    else if (!line.trim()) flush();
    else { if (list) flush(); paragraph.push(line.trim()); }
  }
  flush();
  return out.join("");
}

/** The blocks of one message as HTML. `mrkdwn` draws Slack mrkdwn (the caller's renderer, which knows who a mention is). */
export function renderBlocks(blocks, mrkdwn) {
  const text = (object) => (object.type === "mrkdwn" ? mrkdwn(object.text) : escapeHtml(object.text));
  return blocks.map((block) => {
    switch (block.type) {
      case "header": return `<div class="bk-header">${escapeHtml(block.text.text)}</div>`;
      case "divider": return '<hr class="bk-divider">';
      case "section": return `<div class="bk-section">${block.text ? `<div>${text(block.text)}</div>` : ""}${block.fields ? `<div class="bk-fields">${block.fields.map((field) => `<div>${text(field)}</div>`).join("")}</div>` : ""}</div>`;
      case "context": return `<div class="bk-context">${block.elements.map((element) => `<span>${text(element)}</span>`).join("")}</div>`;
      case "markdown": return `<div class="bk-markdown">${renderMarkdown(block.text)}</div>`;
      case "table": {
        const settings = (column) => block.column_settings?.[column] || {};
        const cell = (value) => (value.type === "raw_text" ? escapeHtml(value.text) : value.elements.map((section) => section.elements.map((element) => (element.type === "link" ? `<a href="${escapeHtml(element.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(element.text)}</a>` : escapeHtml(element.text))).join("")).join(""));
        const row = (values, tag) => `<tr>${values.map((value, column) => `<${tag} style="text-align:${settings(column).align || "left"};white-space:${settings(column).is_wrapped ? "normal" : "nowrap"}">${cell(value)}</${tag}>`).join("")}</tr>`;
        return `<div class="bk-table"><table><thead>${row(block.rows[0], "th")}</thead><tbody>${block.rows.slice(1).map((values) => row(values, "td")).join("")}</tbody></table></div>`;
      }
      case "image": return `<figure class="bk-image">${block.title ? `<figcaption>${escapeHtml(block.title.text)}</figcaption>` : ""}<a href="${escapeHtml(block.image_url)}" target="_blank" rel="noreferrer noopener" aria-label="Image: ${escapeHtml(block.alt_text)}"><span aria-hidden="true">🖼</span> ${escapeHtml(block.alt_text)}</a></figure>`;
      case "actions": return `<div class="bk-actions">${block.elements.map((element) => (element.url
        ? `<a class="bk-button${element.style ? ` ${element.style}` : ""}" href="${escapeHtml(element.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(element.text.text)}</a>`
        : `<button type="button" class="bk-button${element.style ? ` ${element.style}` : ""}" aria-disabled="true" title="The sample Slack does not send clicks to apps yet">${escapeHtml(element.text.text)}</button>`)).join("")}</div>`;
      case "context_actions": return `<div class="bk-context">${block.elements.map((element) => `<span>${escapeHtml(element.positive_button?.text?.text || "Helpful")} · ${escapeHtml(element.negative_button?.text?.text || "Not helpful")}</span>`).join("")}</div>`;
      default: return "";
    }
  }).join("");
}

export const BLOCK_STYLE = `
.blocks{display:grid;gap:8px;max-width:720px}.blocks p{margin:0 0 6px}.blocks p:last-child{margin-bottom:0}
.bk-header{font-size:18px;font-weight:900;line-height:1.33}
.bk-divider,.bk-markdown hr{border:0;border-top:1px solid var(--border);margin:4px 0;width:100%}
.bk-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-top:4px}
.bk-context{display:flex;flex-wrap:wrap;gap:4px 8px;font-size:13px;color:var(--muted)}
.bk-markdown ul,.bk-markdown ol{margin:0 0 6px;padding-left:24px}.bk-markdown blockquote{margin:0 0 6px;padding-left:12px;border-left:4px solid var(--border)}
.bk-markdown pre{margin:0 0 6px;padding:8px;background:rgba(29,28,29,.04);border:1px solid var(--border);border-radius:4px;overflow-x:auto;font-size:12px}
.bk-table{overflow-x:auto;border:1px solid var(--border);border-radius:8px}.bk-table table{border-collapse:collapse;width:100%;font-size:14px}
.bk-table th,.bk-table td{padding:6px 12px;border-bottom:1px solid var(--border);vertical-align:top}.bk-table th{background:rgba(29,28,29,.04);font-weight:700}.bk-table tbody tr:last-child td{border-bottom:0}
.bk-image{margin:0;display:grid;gap:4px}.bk-image figcaption{font-size:13px;color:var(--muted)}.bk-image a{display:block;padding:20px;border:1px dashed rgba(29,28,29,.3);border-radius:8px;text-decoration:none}
.bk-actions{display:flex;flex-wrap:wrap;gap:8px}
.bk-button{display:inline-flex;align-items:center;min-height:32px;padding:0 12px;border:1px solid rgba(29,28,29,.3);border-radius:4px;background:#fff;color:var(--foreground);font:inherit;font-size:13px;font-weight:700;text-decoration:none;cursor:pointer}
.bk-button.primary{border-color:#007a5a;color:#007a5a}.bk-button.danger{border-color:#e01e5a;color:#e01e5a}.bk-button[aria-disabled="true"]{cursor:default}
`;
