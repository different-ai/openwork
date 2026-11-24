// Secret handles for the agent's built-in browser. The model names a secret by an opaque handle,
// the page receives a random placeholder, and the host swaps the placeholder for the value in an
// outgoing request, only when that request goes to an origin the secret is allowed for.
// Memory only: no Electron, I/O or logging. A value leaves this module only inside the headers or
// body `rewrite` returns; never in an error, a status, a summary or a placeholder.
import { randomBytes } from "node:crypto";

/** @typedef {"password" | "code" | "token"} BrowserSecretKind */
/** @typedef {{ secretRef: string, label: string, kind: BrowserSecretKind, origins: string[] }} BrowserSecretSummary */
/** @typedef {{ secretRef: string, ref: string, state: "pending" | "sent" | "not_sent", sentTo?: string[], reason?: string }} BrowserSecretStatus */
/** @typedef {{ action: "continue", headers?: Record<string, string>, body?: Buffer } | { action: "fail" }} BrowserSecretDecision */
/** @typedef {{ tabId: string, url: string, method?: string, headers?: Record<string, string>, body?: Uint8Array | null, bodyComplete?: boolean, resourceType?: string,
 *   requestId?: string, redirectOf?: string, networkId?: string }} BrowserSecretRequest `requestId` names this request, `redirectOf` the request whose redirect it is, `networkId` the whole chain */
/** @typedef {BrowserSecretSummary & { value: string }} Secret */
/** @typedef {{ placeholder: string, sessionId: string, secretRef: string, ref: string, generation: number, expiresAt: number,
 *   endedAt: number | null, endReason: string | null, sentTo: Set<string>, reasons: Set<string>, acted: boolean, missed: number }} Entry */
/** @typedef {{ origins: string[], headers: boolean }} Rewritten a rewritten request: the origins it may reach, and whether its headers, not only its body, carry a value */
/** @typedef {{ generation: number, entries: Entry[], live: Entry[], sent: Rewritten[], rewritten: Map<string, Rewritten>, unbound: Rewritten[], nextChange: number, announced: boolean, guarded: boolean }} TabRecord
 *   `sent` is every rewrite of the tab; `rewritten` names the requests that carry one or may, `unbound` are the rewrites nobody named */
/** @typedef {{ point: string, bytes: number[] }} Unit one code point of a value and its UTF-8 bytes */
/** @typedef {{ replacement: string, widen: boolean, match: (text: string, at: number) => number[] | null }} Candidate `match` gives every offset the encoding can end at */
/** @typedef {{ middle: string, urlSafe: string, widen: boolean, required: number, optional: boolean }} Base64Form */
/** @typedef {{ pattern: RegExp, probe: RegExp, values: Map<string, string>, valueOf: (placeholder: string) => string }} Swaps */

/** @type {BrowserSecretKind[]} */
export const SECRET_KINDS = ["password", "code", "token"];

export class BrowserSecretError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "BrowserSecretError"; this.code = code; }
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PLACEHOLDER_LENGTH = 32;
// Every placeholder of one store starts with the same random letters: one substring scan tells
// whether a request or a text can hold any of them, however many were issued.
const TAG_LENGTH = 8;
const STATUS_RETENTION_MS = 600_000;
const REDACTED = "[secret]";
const REDACTED_PLACEHOLDER = "[secret placeholder]";
// A header that names where a request comes from or goes to, or that the browser owns, never carries a value.
const UNSWAPPED_HEADERS = new Set(["referer", "origin", "host", "cookie"]);
const HEADER_UNSAFE = /[\r\n\0]|[^\0-\xff]/;
// Skip reasons in the order `status` reports them when several were recorded.
const SKIP_REASONS = ["unsupported_encoding", "in_url", "other_origin"];
// Beacons and violation reports never carry a form: they say nothing about where the secret went.
const UNCOUNTED_RESOURCES = new Set(["Ping", "CSPViolationReport", "Preflight"]);
/** @type {Readonly<{ action: "continue" }>} */
const CONTINUE = Object.freeze({ action: "continue" });
/** @type {Readonly<{ action: "fail" }>} */
const FAIL = Object.freeze({ action: "fail" });
/** @type {Entry[]} */
const NONE = [];
const CRLF = Buffer.from("\r\n");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** @param {number} length */
function randomToken(length) {
  let token = "";
  // 248 is the largest multiple of 62 a byte can hold: every character is equally likely.
  while (token.length < length) for (const byte of randomBytes(length)) if (byte < 248 && token.length < length) token += ALPHABET[byte % 62];
  return token;
}
/** @param {string} value */
function originOf(value) {
  try { return new URL(value); } catch { return null; }
}
/** @param {URL} url */
const loopbackHttp = (url) => url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
/** Percent-decodes what it can and leaves the rest, so a placeholder spelled with escapes in an address is still seen. @param {string} text */
function looseDecode(text) {
  let decoded = text;
  for (let pass = 0; pass < 3 && decoded.includes("%"); pass++) decoded = decoded.replace(/%([0-9a-fA-F]{2})/g, (_escape, hex) => String.fromCharCode(parseInt(hex, 16)));
  return decoded;
}
/** @param {Uint8Array | null | undefined} body */
const asBuffer = (body) => Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : null;
/** @param {string | undefined} header */
function mediaType(header) {
  if (typeof header !== "string") return null;
  const [essence, ...rest] = header.split(";");
  /** @type {Map<string, string>} */
  const parameters = new Map();
  for (const part of rest) {
    const at = part.indexOf("=");
    if (at !== -1) parameters.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim().replace(/^"(.*)"$/, "$1"));
  }
  return { type: essence.trim().toLowerCase(), charset: parameters.get("charset"), boundary: parameters.get("boundary") };
}
/** @param {Uint8Array} bytes */
function decodeUtf8(bytes) {
  try { return strictUtf8.decode(bytes); } catch { return null; }
}
/** True when `text` is itself JSON, so replacing inside it would need that encoding's escapes too. @param {string} text */
function parsesAsJson(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}
/** @param {string} text */
function jsonContainer(text) {
  if (!/^\s*[[{]/.test(text)) return false;
  try { return typeof JSON.parse(text) === "object"; } catch { return false; }
}
/** @param {string} text @param {Swaps} swaps */
function swapText(text, swaps) {
  if (!swaps.probe.test(text)) return text;
  if (parsesAsJson(text)) throw new Error("nested encoding");
  return text.replace(swaps.pattern, swaps.valueOf);
}
/** The parsed JSON with every placeholder replaced in every string, keys included. @param {unknown} node @param {Swaps} swaps @returns {unknown} */
function swapParsed(node, swaps) {
  if (typeof node === "string") return swapText(node, swaps);
  if (Array.isArray(node)) return node.map((item) => swapParsed(item, swaps));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [swapText(key, swaps), swapParsed(item, swaps)]));
  return node;
}
/** @param {unknown} a @param {unknown} b @returns {boolean} */
function sameJson(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  const other = new Map(Object.entries(b)), entries = Object.entries(a);
  return entries.length === other.size && entries.every(([key, item]) => other.has(key) && sameJson(item, other.get(key)));
}
// Each body encoding is rewritten as text and then proven: the original and the result are both
// parsed, and the result must be the original with the value in place of the placeholder in every
// string. Anything else throws, which fails the request.
/** @param {string} text @param {Swaps} swaps */
function swapJson(text, swaps) {
  const expected = swapParsed(JSON.parse(text), swaps);
  const rewritten = text.replace(swaps.pattern, (placeholder) => jsonEscaped(swaps.valueOf(placeholder)));
  if (!sameJson(JSON.parse(rewritten), expected)) throw new Error("rewrite changed the structure");
  return Buffer.from(rewritten, "utf8");
}
/** @param {string} text @param {Swaps} swaps */
function swapForm(text, swaps) {
  const before = [...new URLSearchParams(text)];
  const rewritten = text.replace(swaps.pattern, (placeholder) => formEncoded(swaps.valueOf(placeholder)));
  const after = [...new URLSearchParams(rewritten)];
  if (before.length !== after.length || !before.every(([name, value], index) => swapText(name, swaps) === after[index][0] && swapText(value, swaps) === after[index][1])) {
    throw new Error("rewrite changed the structure");
  }
  return Buffer.from(rewritten, "utf8");
}
/** @param {string} value */
const formEncoded = (value) => new URLSearchParams([["", value]]).toString().slice(1);
/** @param {string} value */
const jsonEscaped = (value) => JSON.stringify(value).slice(1, -1);
/** @param {Buffer} bytes @param {Swaps} swaps */
function swapBytes(bytes, swaps) {
  /** @type {{ at: number, value: string }[]} */
  const found = [];
  for (const [placeholder, value] of swaps.values) {
    for (let at = bytes.indexOf(placeholder); at !== -1; at = bytes.indexOf(placeholder, at + PLACEHOLDER_LENGTH)) found.push({ at, value });
  }
  found.sort((a, b) => a.at - b.at);
  const chunks = [];
  let from = 0;
  for (const { at, value } of found) { chunks.push(bytes.subarray(from, at), Buffer.from(value, "utf8")); from = at + PLACEHOLDER_LENGTH; }
  chunks.push(bytes.subarray(from));
  return Buffer.concat(chunks);
}
/** The parts of a browser-made multipart body; anything shaped otherwise throws. @param {Buffer} body @param {string | undefined} boundary */
function multipartParts(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  const next = Buffer.concat([CRLF, delimiter]);
  if (!boundary || body.indexOf(delimiter) !== 0) throw new Error("malformed multipart");
  const parts = [];
  for (let cursor = delimiter.length; !(body[cursor] === 45 && body[cursor + 1] === 45);) {
    if (body[cursor] !== 13 || body[cursor + 1] !== 10) throw new Error("malformed multipart");
    // The delimiter's own line break opens the blank line of a part without headers.
    const blank = body.indexOf("\r\n\r\n", cursor);
    const end = blank === -1 ? -1 : body.indexOf(next, blank + 4);
    if (end === -1) throw new Error("malformed multipart");
    parts.push({ headers: body.subarray(Math.min(cursor + 2, blank), blank), start: blank + 4, end });
    cursor = end + next.length;
  }
  return parts;
}
/** How many placeholders `bytes` holds. @param {Buffer} bytes @param {Swaps} swaps */
const placeholdersIn = (bytes, swaps) => bytes.toString("latin1").match(swaps.pattern)?.length ?? 0;
/** @param {Buffer} body @param {string | undefined} boundary @param {Swaps} swaps */
function swapMultipart(body, boundary, swaps) {
  const parts = multipartParts(body, boundary);
  // Whether a body is refused never depends on the page's boundary and the value together, or the page could
  // learn the value one guess at a time. A value is refused for what it is alone: a line break, or the two
  // dashes every delimiter starts with. A body is refused for what the page wrote alone: see below.
  for (const value of swaps.values.values()) if (/[\r\n]/.test(value) || value.startsWith("--")) throw new Error("value cannot sit in multipart");
  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  let inParts = 0;
  for (const part of parts) {
    const content = body.subarray(part.start, part.end);
    const held = [...content.toString("latin1").matchAll(swaps.pattern)];
    if (!held.length) continue;
    inParts += held.length;
    // A placeholder that follows the start of a delimiter on its line could complete it with the right value.
    for (const { index } of held) {
      const line = body.subarray(body.lastIndexOf(CRLF, part.start + index - 2) + 2, part.start + index);
      if (line.length && delimiter.subarray(0, line.length).equals(line)) throw new Error("placeholder inside a delimiter");
    }
    for (const line of part.headers.toString("latin1").split("\r\n")) {
      const name = line.slice(0, line.indexOf(":")).trim().toLowerCase();
      const type = name === "content-type" ? mediaType(line.slice(line.indexOf(":") + 1)) : null;
      if (name === "content-transfer-encoding" || type && (type.type !== "text/plain" || type.charset && !/^utf-?8$/i.test(type.charset))) throw new Error("encoded part");
    }
    const text = decodeUtf8(content);
    if (text !== null && parsesAsJson(text)) throw new Error("nested encoding");
  }
  // A placeholder in a part's headers, between parts or after the last one is never replaced.
  if (inParts !== placeholdersIn(body, swaps)) throw new Error("placeholder outside a part body");
  const rewritten = swapBytes(body, swaps);
  const after = multipartParts(rewritten, boundary);
  if (after.length !== parts.length || !parts.every((part, index) => part.headers.equals(after[index].headers)
    && swapBytes(body.subarray(part.start, part.end), swaps).equals(rewritten.subarray(after[index].start, after[index].end)))) throw new Error("rewrite changed the structure");
  return rewritten;
}
/** @param {Buffer} body @param {string | undefined} contentType @param {Swaps} swaps */
function swapBody(body, contentType, swaps) {
  const media = mediaType(contentType);
  if (!media || media.charset && !/^utf-?8$/i.test(media.charset)) throw new Error("unsupported encoding");
  if (media.type === "multipart/form-data") return swapMultipart(body, media.boundary, swaps);
  if (media.type === "text/plain") {
    const text = decodeUtf8(body);
    return text !== null && jsonContainer(text) ? swapJson(text, swaps) : swapBytes(body, swaps);
  }
  if (media.type === "application/json" || media.type.endsWith("+json")) return swapJson(strictUtf8.decode(body), swaps);
  if (media.type === "application/x-www-form-urlencoded") return swapForm(strictUtf8.decode(body), swaps);
  throw new Error("unsupported encoding");
}

// Redaction. A value and a placeholder are recognised raw and in each encoding a page or a server
// commonly echoes them in: percent-encoding, JSON escapes, HTML character references, hex, base64
// (line-wrapped too), and UTF-8 read as Windows-1252 or Latin-1. A text is scanned once: two
// adjacent characters select the few encodings that can start there, and each is then checked
// character by character, so cost grows with the text, not with the number of the secrets.
// Anything else a page does to a value (reversing it, splitting it, a cipher) is not recognised.
/** @type {Record<string, string>} */
const JSON_SHORT = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
/** @type {Record<string, string>} */
const HTML_NAMED = { "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos" };
/** @param {string} text */
const codes = (text) => Array.from({ length: text.length }, (_unused, index) => text.charCodeAt(index));
/** @param {number[]} ends @param {number} end */
const reach = (ends, end) => { if (!ends.includes(end)) ends.push(end); };
/** @param {number} code */
const base64Code = (code) => code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 43 || code === 47 || code === 45 || code === 95;
/** A line break, space or tab: hex and base64 are wrapped and grouped with them. @param {number} code */
const blank = (code) => code === 13 || code === 10 || code === 32 || code === 9;
/** Past at most `most` blanks at `at`. @param {string} text @param {number} at @param {(code: number) => boolean} [skipped] @param {number} [most] */
function gap(text, at, skipped = blank, most = 4) {
  let end = at;
  while (end < at + most && skipped(text.charCodeAt(end))) end++;
  return end;
}
/** @param {number} code */
const lineBreak = (code) => code === 13 || code === 10;
// What the bytes 0x80 to 0x9f show as in a page without a charset, which a browser reads as Windows-1252.
const CP1252 = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";
/** The characters one byte of UTF-8 can show as when it is read as Windows-1252 or Latin-1. @param {number} byte */
const misread = (byte) => byte >= 0x80 && byte < 0xa0 ? [byte, CP1252.charCodeAt(byte - 0x80)] : [byte];
/** @param {number} code */
const alphanumeric = (code) => code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122;
/** The number written as `digits` hex characters at `at`, or -1. @param {string} text @param {number} at @param {number} digits */
function hexValue(text, at, digits) {
  let value = 0;
  for (let index = 0; index < digits; index++) {
    const code = text.charCodeAt(at + index), lower = code | 32;
    const digit = code >= 48 && code <= 57 ? code - 48 : lower >= 97 && lower <= 102 ? lower - 87 : -1;
    if (digit === -1) return -1;
    value = value * 16 + digit;
  }
  return value;
}
/** Ends of `%XX` for one byte at `at`, however many times the percent sign was itself encoded (`%25XX`, `%2525XX`). @param {string} text @param {number} at @param {number} byte @param {number[]} ends */
function percentEnds(text, at, byte, ends) {
  if (text.charCodeAt(at) !== 37) return;
  for (let depth = 0, cursor = at + 1; depth < 5; depth++, cursor += 2) {
    const pair = hexValue(text, cursor, 2);
    if (pair === byte) reach(ends, cursor + 2);
    if (pair !== 0x25) return;
  }
}
/**
 * Where one character of a value can end when it starts at `at`: raw, its UTF-8 bytes misread one
 * character each, `+` for a space, percent-encoded bytes, a JSON escape, or an HTML character reference.
 * @param {string} text @param {number} at @param {Unit} unit @param {number[]} ends
 */
function unitEnds(text, at, unit, ends) {
  const point = unit.point, code = text.charCodeAt(at);
  if (text.startsWith(point, at)) reach(ends, at + point.length);
  if (unit.bytes.length > 1 && unit.bytes.every((byte, index) => misread(byte).includes(text.charCodeAt(at + index)))) reach(ends, at + unit.bytes.length);
  if (code === 43) { if (point === " ") reach(ends, at + 1); }
  else if (code === 37) {
    let starts = [at];
    for (const byte of unit.bytes) {
      /** @type {number[]} */
      const after = [];
      for (const start of starts) percentEnds(text, start, byte, after);
      starts = after;
    }
    for (const end of starts) reach(ends, end);
  } else if (code === 92) {
    const short = Object.hasOwn(JSON_SHORT, point) ? JSON_SHORT[point] : null;
    if (short && text.charCodeAt(at + 1) === short.charCodeAt(1) || point === "/" && text.charCodeAt(at + 1) === 47) reach(ends, at + 2);
    let end = at;
    for (let index = 0; index < point.length && end !== -1; index++) {
      end = text.charCodeAt(end) === 92 && text.charCodeAt(end + 1) === 117 && hexValue(text, end + 2, 4) === point.charCodeAt(index) ? end + 6 : -1;
    }
    if (end !== -1) reach(ends, end);
  } else if (code === 38) {
    const reference = text.slice(at + 1, at + 12), close = reference.indexOf(";");
    if (close === -1) return;
    const name = reference.slice(0, close).toLowerCase(), target = point.codePointAt(0);
    if (Object.hasOwn(HTML_NAMED, point) && name === HTML_NAMED[point]
      || /^#\d{1,8}$/.test(name) && Number(name.slice(1)) === target
      || /^#x[0-9a-f]{1,7}$/.test(name) && parseInt(name.slice(2), 16) === target) reach(ends, at + close + 2);
  }
}
/** Every offset where `units`, from the one at `from` on, matched from `at`, can end; null when they do not match. @param {string} text @param {number} at @param {Unit[]} units @param {number} [from] */
function matchUnits(text, at, units, from = 0) {
  let ends = [at];
  for (let index = from; index < units.length; index++) {
    const unit = units[index];
    const code = ends.length === 1 ? text.charCodeAt(ends[0]) : -1;
    // Away from an escape character a character of one byte can only match raw: no list is built.
    if (code !== -1 && code !== 37 && code !== 92 && code !== 38 && code !== 43 && unit.bytes.length === 1) {
      if (!text.startsWith(unit.point, ends[0])) return null;
      ends[0] += unit.point.length;
      continue;
    }
    /** @type {number[]} */
    const next = [];
    for (const from of ends) unitEnds(text, from, unit, next);
    if (!next.length) return null;
    ends = next;
  }
  return ends;
}
/** The first one or two characters each spelling of a unit can start with; null when that spelling is one character long. @param {Unit} unit @returns {Array<[number[], number[] | null]>} */
function unitHeads(unit) {
  const point = unit.point, high = unit.bytes[0].toString(16).padStart(2, "0")[0];
  /** @type {Array<[number[], number[] | null]>} */
  const heads = [
    [[point.charCodeAt(0)], point.length > 1 ? [point.charCodeAt(1)] : null],
    [[37], codes(`2${high}${high.toUpperCase()}`)],
    [[92], codes(`u${Object.hasOwn(JSON_SHORT, point) ? JSON_SHORT[point][1] : ""}${point === "/" ? "/" : ""}`)],
    [[38], codes(`#${Object.hasOwn(HTML_NAMED, point) ? `${HTML_NAMED[point][0]}${HTML_NAMED[point][0].toUpperCase()}` : ""}`)],
  ];
  if (point === " ") heads.push([[43], null]);
  if (unit.bytes.length > 1) heads.push([[unit.bytes[0]], misread(unit.bytes[1])]);
  return heads;
}
/** @param {string} point @returns {Unit} */
const unitOf = (point) => ({ point, bytes: [...Buffer.from(point, "utf8")] });
/** The end of one letter or digit at `at`, raw or spelled as an escape, or -1. @param {string} text @param {number} at */
function alphanumericEnd(text, at) {
  const code = text.charCodeAt(at);
  if (alphanumeric(code)) return at + 1;
  if (code === 37) {
    for (let depth = 0, cursor = at + 1; depth < 5; depth++, cursor += 2) {
      const pair = hexValue(text, cursor, 2);
      if (pair !== 0x25) return alphanumeric(pair) ? cursor + 2 : -1;
    }
  } else if (code === 92) {
    if (text.charCodeAt(at + 1) === 117 && alphanumeric(hexValue(text, at + 2, 4))) return at + 6;
  } else if (code === 38) {
    const reference = /^&#(?:(\d{1,8})|x([0-9a-f]{1,7}));/i.exec(text.slice(at, at + 12));
    if (reference && alphanumeric(reference[1] ? Number(reference[1]) : parseInt(reference[2], 16))) return at + reference[0].length;
  }
  return -1;
}
/**
 * The end of a fixed text matched in either of two alphabets (hex in both cases, base64 and base64url), with the
 * blanks it may be wrapped or grouped by between its characters, or -1. `from` skips characters already matched.
 * @param {string} text @param {number} at @param {string} first @param {string} second @param {number} [from]
 */
function matchSpaced(text, at, first, second, from = 0) {
  let end = at;
  for (let index = from; index < first.length; index++) {
    if (index) end = gap(text, end);
    const code = text.charCodeAt(end++);
    if (code !== first.charCodeAt(index) && code !== second.charCodeAt(index)) return -1;
  }
  return end;
}
/** Marks each shift at which `run` continues itself ("abab" at 2). @param {string} run */
function periodsOf(run) {
  const size = run.length, z = new Uint32Array(size), periods = new Uint8Array(size);
  for (let index = 1, left = 0, right = 0; index < size; index++) {
    if (index < right) z[index] = Math.min(right - index, z[index - left]);
    while (index + z[index] < size && run.charCodeAt(z[index]) === run.charCodeAt(index + z[index])) z[index]++;
    if (index + z[index] > right) { left = index; right = index + z[index]; }
    if (index + z[index] === size) periods[index] = 1;
  }
  return periods;
}
// Every scan of a text has its own number: what a candidate remembers of one scan means nothing in the next.
let scan = 0;
/**
 * Finds one fixed run of characters wherever a scan asks, and remembers where it last found it unbroken. Inside
 * that copy the run can only start again at one of its own periods, and then only what lies past the copy is
 * compared: a page that repeats the run ("xxxx…") costs its own length, not its length times the run's.
 * `rest(text, at, from)` matches the run from its character `from` on and gives its end or -1.
 * @param {string} run @param {(text: string, at: number, from: number) => number} rest
 * @returns {(text: string, at: number) => number}
 */
function runMatcher(run, rest) {
  const periods = periodsOf(run);
  let seen = 0, copy = 0;
  return (text, at) => {
    const shift = seen === scan ? at - copy : 0;
    if (shift > 0 && shift < run.length && !periods[shift]) return -1;
    const end = shift > 0 && shift < run.length ? rest(text, copy + run.length, run.length - shift) : rest(text, at, 0);
    if (end === at + run.length) { seen = scan; copy = at; }
    return end;
  };
}
/**
 * Base64 of `bytes` inside a longer text ("name:password") depends on where they start in their group of three.
 * The characters that hold only their bits are matched exactly. Then come the `required` characters of the `tail`
 * bytes that follow them in the same token, or else the one character that mixes their last bits with a neighbour's.
 * @param {Buffer} bytes @param {number} [tail] @returns {Base64Form[]}
 */
function base64Forms(bytes, tail = 0) {
  return [0, 1, 2].map((lead) => {
    const encoded = Buffer.concat([Buffer.alloc(lead), bytes]).toString("base64").replace(/=+$/, "");
    const partial = (lead + bytes.length) % 3 !== 0;
    const middle = encoded.slice([0, 2, 3][lead], partial ? -1 : undefined);
    return { middle, urlSafe: middle.replaceAll("+", "-").replaceAll("/", "_"), widen: lead > 0,
      required: tail ? Math.ceil((lead + bytes.length + tail) * 8 / 6) - [0, 2, 3][lead] - middle.length : 0, optional: !tail && partial };
  });
}
/** @param {string} text @param {number} end where the characters of `form.middle` ended, or -1 @param {Base64Form} form */
function base64Tail(text, end, form) {
  if (end === -1) return null;
  // Where the token goes on: here, or at the start of the next line.
  const next = () => gap(text, end, lineBreak, 2);
  for (let left = form.required; left > 0; left--) {
    end = next();
    if (!base64Code(text.charCodeAt(end++))) return null;
  }
  if (form.optional && base64Code(text.charCodeAt(next()))) end = next() + 1;
  for (let padding = 0; (form.optional || form.required) && padding < 2 && text.charCodeAt(next()) === 61; padding++) end = next() + 1;
  return [end];
}
/** @param {string} tag @param {Iterable<string>} values */
function compileMatcher(tag, values) {
  const ascii = new Uint8Array(128 * 128);
  /** @type {Map<number, Candidate[]>} */
  const pairs = new Map();
  let wide = false;
  /** @param {number[]} first @param {number[]} second @param {Candidate} candidate */
  const register = (first, second, candidate) => {
    for (const a of first) for (const b of second) {
      const key = a * 65536 + b, list = pairs.get(key);
      if (list) { if (!list.includes(candidate)) list.push(candidate); } else pairs.set(key, [candidate]);
      if (a < 128 && b < 128) ascii[a << 7 | b] = 1; else wide = true;
    }
  };
  const blanks = [13, 10, 32, 9];
  /**
   * Every encoding of `text`, followed in the same encoding by `tail` letters or digits: a value has none, a
   * placeholder is the store's tag and then its random part.
   * @param {string} text @param {number} tail @param {string} replacement
   */
  const add = (text, tail, replacement) => {
    const units = Array.from(text, unitOf);
    const following = unitHeads(units[1]).flatMap(([first]) => first);
    // A value none of whose characters can be read as an escape or misread has one spelling inside its own raw copy.
    const raw = !tail && !/[%\\&+]/.test(text) && units.length === Buffer.byteLength(text)
      ? runMatcher(text, (page, at, from) => { const ends = matchUnits(page, at, units, from); return ends?.length === 1 ? ends[0] : ends ? -2 : -1; }) : null;
    /** @type {Candidate} */
    const spelled = { replacement, widen: false, match(page, at) {
      const end = raw ? raw(page, at) : -2;
      const ends = end === -2 ? matchUnits(page, at, units) : end === -1 ? null : [end];
      if (!ends || !tail) return ends;
      /** @type {number[]} */
      const whole = [];
      for (let end of ends) {
        for (let left = tail; left > 0 && end !== -1; left--) end = alphanumericEnd(page, end);
        if (end !== -1) reach(whole, end);
      }
      return whole.length ? whole : null;
    } };
    for (const [first, second] of unitHeads(units[0])) register(first, second ?? following, spelled);
    const bytes = Buffer.from(text, "utf8");
    const hex = bytes.toString("hex"), upper = hex.toUpperCase();
    const hexRun = runMatcher(hex, (page, at, from) => matchSpaced(page, at, hex, upper, from));
    register([hex.charCodeAt(0), upper.charCodeAt(0)], [hex.charCodeAt(1), upper.charCodeAt(1), ...blanks], { replacement, widen: false, match(page, at) {
      let end = hexRun(page, at);
      for (let left = tail; left > 0 && end !== -1; left--) {
        end = gap(page, end);
        end = alphanumeric(hexValue(page, end, 2)) ? end + 2 : -1;
      }
      return end === -1 ? null : [end];
    } });
    for (const form of base64Forms(bytes, tail)) {
      const run = runMatcher(form.middle, (page, at, from) => matchSpaced(page, at, form.middle, form.urlSafe, from));
      register([form.middle.charCodeAt(0), form.urlSafe.charCodeAt(0)], [form.middle.charCodeAt(1), form.urlSafe.charCodeAt(1), ...blanks],
        { replacement, widen: form.widen, match: (page, at) => base64Tail(page, run(page, at), form) });
    }
  };
  add(tag, PLACEHOLDER_LENGTH - TAG_LENGTH, REDACTED_PLACEHOLDER);
  const known = [...new Set(values)].sort((a, b) => b.length - a.length);
  for (const value of known) add(value, 0, REDACTED);
  // No encoding above takes more than eleven characters for one byte, and a few more at its two ends.
  const longest = Math.max(PLACEHOLDER_LENGTH, ...known.map((value) => Buffer.byteLength(value))) * 11 + 16;
  return { ascii, pairs, wide, values: known, span: 2 ** Math.max(9, Math.ceil(Math.log2(longest))) };
}

/**
 * @param {{ allowLoopbackHttp?: boolean, placeholderTtlMs?: number, maxPerSession?: number, now?: () => number }} [options]
 * `now` is the clock expiry is measured on; tests pass their own.
 */
export function createBrowserSecrets({ allowLoopbackHttp = false, placeholderTtlMs = 300_000, maxPerSession = 20, now = Date.now } = {}) {
  // A placeholder starts with a letter, so it is never JSON on its own.
  const tag = `${ALPHABET[randomBytes(1)[0] % 52]}${randomToken(TAG_LENGTH - 1)}`;
  /** @type {Map<string, Map<string, Secret>>} */
  const sessions = new Map();
  // Every value ever saved here, kept apart from the secrets in use for as long as the store lives. A site that
  // was sent a value can show it back at any time, on a page read long after the person removed the secret:
  // removing a secret stops it being entered, and what it was is still never read back to the agent.
  /** @type {Set<string>} */
  const redacted = new Set();
  /** @type {Map<string, TabRecord>} */
  const tabs = new Map();
  /** @type {Set<(tabId: string, live: boolean) => void>} */
  const listeners = new Set();
  /** @type {Set<(tabId: string, guarded: boolean) => void>} */
  const guardListeners = new Set();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {ReturnType<typeof compileMatcher> | null} */
  let matcher = null;

  /** @param {Secret} secret @returns {BrowserSecretSummary} */
  const summary = ({ secretRef, label, kind, origins }) => ({ secretRef, label, kind, origins: [...origins] });
  /** @param {Entry} entry */
  const secretOf = (entry) => sessions.get(entry.sessionId)?.get(entry.secretRef);
  /** @param {Entry} entry @param {string} reason @param {number} at */
  const end = (entry, reason, at) => { entry.endedAt = at; entry.endReason = reason; entry.placeholder = ""; };

  // Expiry is decided here, on every read, from the clock alone. The timer below only makes sure
  // a host that is waiting for `onLiveChange` hears about an expiry nobody read.
  /** @param {string} tabId @returns {Entry[]} the tab's placeholders that can still be swapped */
  function settle(tabId) {
    const record = tabs.get(tabId);
    if (!record) return NONE;
    const at = now();
    if (at < record.nextChange) return record.live;
    record.entries = record.entries.filter((entry) => {
      if (entry.endedAt === null && entry.expiresAt <= at) end(entry, "expired", entry.expiresAt);
      return entry.endedAt === null || entry.endedAt + STATUS_RETENTION_MS > at;
    });
    record.live = record.entries.filter((entry) => entry.endedAt === null);
    record.nextChange = Math.min(...record.entries.map((entry) => entry.endedAt === null ? entry.expiresAt : entry.endedAt + STATUS_RETENTION_MS));
    const sent = record.sent.length > 0;
    if (!record.entries.length && !sent) tabs.delete(tabId);
    const live = record.live.length > 0, guarded = live || sent;
    // One listener failing must not stop the others or the store.
    if (live !== record.announced) {
      record.announced = live;
      for (const listener of [...listeners]) try { listener(tabId, live); } catch {}
    }
    if (guarded !== record.guarded) {
      record.guarded = guarded;
      for (const listener of [...guardListeners]) try { listener(tabId, guarded); } catch {}
    }
    return record.live;
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    let next = Infinity;
    for (const record of tabs.values()) next = Math.min(next, record.nextChange);
    if (next === Infinity) return;
    timer = setTimeout(() => { timer = null; for (const tabId of [...tabs.keys()]) settle(tabId); schedule(); }, Math.min(Math.max(next - now(), 1), 2 ** 31 - 1));
    // An idle store never keeps the process alive.
    timer.unref();
  }
  /** Ends every live placeholder `match` selects and tells listeners. @param {(entry: Entry, tabId: string) => boolean} match @param {string} reason */
  function revoke(match, reason) {
    const at = now();
    for (const [tabId, record] of [...tabs]) {
      for (const entry of record.live) if (match(entry, tabId)) { end(entry, reason, at); record.nextChange = -Infinity; }
      settle(tabId);
    }
    schedule();
  }

  /** @param {unknown} origin @param {(message: string) => never} invalid */
  function siteOrigin(origin, invalid) {
    const url = typeof origin === "string" ? originOf(origin) : null;
    // Nothing the person typed is repeated: a secret pasted into the wrong box must not come back in an error.
    if (!url || url.origin !== origin || url.hostname.includes("*")) return invalid("Enter each website as its address only, like https://example.com, with no path.");
    if (url.protocol !== "https:" && !(allowLoopbackHttp && loopbackHttp(url))) return invalid("A secret can only be sent to websites that use https.");
    return url.origin;
  }

  // What a page sends on its own, before the agent clicks or presses a key, says nothing about a
  // form the agent has not submitted yet: only requests after `noteAction` are counted.
  /** @param {BrowserSecretRequest} input @param {Entry[]} entries @param {Buffer | null} body */
  function countMissed(input, entries, body) {
    if (!entries.length || !body?.length || input.bodyComplete === false || UNCOUNTED_RESOURCES.has(String(input.resourceType))) return;
    if (["GET", "HEAD"].includes(String(input.method).toUpperCase())) return;
    const origin = originOf(input.url)?.origin;
    if (origin) for (const entry of entries) if (entry.acted && secretOf(entry)?.origins.includes(origin)) entry.missed++;
  }

  /** The origin a value may be swapped into for this request, or null. @param {BrowserSecretRequest} input */
  function destinationOf(input) {
    const target = originOf(input.url);
    return target && input.resourceType !== "WebSocket" && (target.protocol === "https:" || allowLoopbackHttp && loopbackHttp(target)) ? target.origin : null;
  }
  /** @param {BrowserSecretRequest} input the names a host gave this request */
  const namesOf = (input) => [typeof input.requestId === "string" ? `id:${input.requestId}` : "", typeof input.networkId === "string" ? `net:${input.networkId}` : ""].filter(Boolean);
  /**
   * Chromium follows a 307 or 308 redirect with the body and headers the host rewrote, so the next hop arrives
   * holding the value, not the placeholder, however long the server waits and whatever became of the placeholder.
   * True when this request is such a hop to an origin that may not have the value. A hop without a body left a
   * rewritten body behind (a 302 after a sign-in) and goes on. Nothing here looks at what a request holds: whether
   * a request goes through never tells a page if a guess of the value was right.
   * A host names each request and the one it redirects (`decidePausedRequest` does): then only the redirects of a
   * rewritten request are stopped. A rewrite nobody named cannot be told from the page's own next request, so until
   * the tab closes no request that could be its redirect leaves for another origin.
   * @param {TabRecord} record @param {BrowserSecretRequest} input @param {Buffer | null} body
   */
  function replaysRewrite(record, input, body) {
    const destination = destinationOf(input);
    const carries = input.bodyComplete === false || body !== null && body.length > 0;
    const stopped = (/** @type {Rewritten} */ sent) => !(destination !== null && sent.origins.includes(destination)) && (sent.headers || carries);
    for (const key of [typeof input.redirectOf === "string" ? `id:${input.redirectOf}` : "", typeof input.networkId === "string" ? `net:${input.networkId}` : ""]) {
      const sent = record.rewritten.get(key);
      if (!sent) continue;
      if (stopped(sent)) return true;
      // The hop carries on what its request carried.
      for (const name of namesOf(input)) record.rewritten.set(name, sent);
    }
    if (record.unbound.some(stopped)) return true;
    // The browser keeps a rewritten body in the tab's history and sends it again on a reload, as a new request that
    // follows nothing. Any later request to an origin a rewrite went to, that could be such a resend, is followed
    // like the rewrite itself. Its content is not looked at.
    const resent = record.sent.filter((sent) => destination !== null && sent.origins.includes(destination) && (sent.headers || carries));
    const tagged = resent.length ? { origins: resent.map((sent) => sent.origins).reduce((all, each) => all.filter((origin) => each.includes(origin))), headers: resent.some((sent) => sent.headers) } : null;
    if (tagged) for (const name of namesOf(input)) if (!record.rewritten.has(name)) record.rewritten.set(name, tagged);
    return false;
  }

  /** @param {BrowserSecretRequest} input @param {Entry[]} live @param {TabRecord} record @returns {BrowserSecretDecision} */
  function decide(input, live, record) {
    const url = input.url;
    const headers = Object.entries(input.headers ?? {});
    const body = asBuffer(input.body);
    if (replaysRewrite(record, input, body)) return FAIL;
    if (!live.length) return CONTINUE;
    const decodedUrl = url.includes("%") ? looseDecode(url) : url;
    const tagged = (/** @type {unknown} */ value) => typeof value === "string" && value.includes(tag);
    if (!decodedUrl.includes(tag) && !url.includes(tag) && !(body?.includes(tag)) && !headers.some(([, value]) => tagged(value))) {
      countMissed(input, live, body);
      return CONTINUE;
    }
    const referer = headers.filter(([name]) => name.toLowerCase() === "referer").map(([, value]) => String(value)).join("\n");
    const swappable = headers.filter(([name, value]) => !UNSWAPPED_HEADERS.has(name.toLowerCase()) && tagged(value));
    const present = live.flatMap((entry) => {
      const where = { address: url.includes(entry.placeholder) || decodedUrl.includes(entry.placeholder) || referer.includes(entry.placeholder) || looseDecode(referer).includes(entry.placeholder),
        header: swappable.some(([, value]) => value.includes(entry.placeholder)), body: body?.includes(entry.placeholder) === true };
      return where.address || where.header || where.body ? [{ entry, ...where }] : [];
    });
    countMissed(input, live.filter((entry) => !present.some((found) => found.entry === entry)), body);
    if (!present.length) return CONTINUE;
    // A placeholder in an address reaches logs, history and other sites' Referer: such a request never carries a value.
    if (present.some((found) => found.address)) {
      for (const { entry } of present) entry.reasons.add("in_url");
      return CONTINUE;
    }
    const destination = destinationOf(input);
    const allowed = present.flatMap((found) => {
      const secret = destination ? secretOf(found.entry) : undefined;
      if (destination && secret?.origins.includes(destination)) return [{ ...found, secret }];
      found.entry.reasons.add("other_origin");
      return [];
    });
    // What is not allowed here stays a placeholder: the request goes on with the allowed values only.
    if (!destination || !allowed.length) return CONTINUE;
    try {
      const values = new Map(allowed.map(({ entry, secret }) => [entry.placeholder, secret.value]));
      const alternatives = [...values.keys()].join("|");
      /** @type {Swaps} */
      const swaps = { pattern: new RegExp(alternatives, "g"), probe: new RegExp(alternatives), values, valueOf(placeholder) {
        const value = values.get(placeholder);
        if (value === undefined) throw new Error("not a placeholder of this request");
        return value;
      } };
      /** @type {{ headers?: Record<string, string>, body?: Buffer }} */
      const changes = {};
      if (allowed.some((found) => found.header)) {
        if (allowed.some((found) => found.header && HEADER_UNSAFE.test(found.secret.value))) throw new Error("value cannot sit in a header");
        // The whole list goes back with its names and order; the browser recomputes Content-Length.
        changes.headers = Object.fromEntries(headers.filter(([name]) => name.toLowerCase() !== "content-length")
          .map(([name, value]) => [name, swappable.some(([other]) => other === name) ? value.replace(swaps.pattern, swaps.valueOf) : value]));
      }
      if (body && allowed.some((found) => found.body)) {
        if (input.bodyComplete === false) throw new Error("body was not read whole");
        changes.body = swapBody(body, headers.find(([name]) => name.toLowerCase() === "content-type")?.[1], swaps);
      }
      for (const { entry } of allowed) entry.sentTo.add(destination);
      // What is kept of a rewritten request is its name and where it may go, never what it holds. It is kept until
      // the tab closes: a server can answer with a redirect as late as it likes.
      if (changes.headers || changes.body) {
        const origins = allowed.map(({ secret }) => secret.origins).reduce((all, each) => all.filter((origin) => each.includes(origin)));
        const names = namesOf(input);
        const sent = { origins, headers: changes.headers !== undefined };
        record.sent.push(sent);
        for (const name of names) record.rewritten.set(name, sent);
        if (!names.length) record.unbound.push(sent);
        record.nextChange = -Infinity;
        settle(input.tabId);
      }
      return { action: "continue", ...changes };
    } catch {
      for (const { entry } of allowed) entry.reasons.add("unsupported_encoding");
      return FAIL;
    }
  }

  /** @typedef {ReturnType<typeof compileMatcher>} Matcher */
  const compiled = () => matcher ??= compileMatcher(tag, redacted);
  /**
   * `text` with every match replaced. With a `limit`, the text is cut there as well, and a match that reaches
   * across the cut goes whole: the caller reads the text `span` characters past its cut so that none is missed.
   * @param {Matcher} known @param {string} text @param {number} [limit]
   */
  function redactTextWith(known, text, limit = Infinity) {
    if (typeof text !== "string") return text;
    const cut = Math.min(text.length, Math.max(0, limit));
    const { ascii, pairs, wide } = known;
    scan++;
    // One stretch of text to replace: matches that overlap it extend it.
    let redacted = "", copied = 0, start = -1, stop = -1, replacement = "";
    for (let at = 0, last = Math.min(text.length - 1, cut); at < last; at++) {
      const first = text.charCodeAt(at), second = text.charCodeAt(at + 1);
      const candidates = (first < 128 && second < 128 ? ascii[first << 7 | second] === 1 : wide) ? pairs.get(first * 65536 + second) : undefined;
      let far = -1, chosen = null;
      if (candidates) for (const candidate of candidates) {
        const ends = candidate.match(text, at);
        // The longest encoding that matches here wins, so no tail of a longer secret is left behind.
        if (ends && Math.max(...ends) > far) { far = Math.max(...ends); chosen = candidate; }
      }
      if (!chosen) continue;
      // The character that shares its bits with the value's first byte, on this line or at the end of the one before.
      let before = at;
      while (chosen.widen && before > at - 2 && lineBreak(text.charCodeAt(before - 1))) before--;
      const from = chosen.widen && before > 0 && base64Code(text.charCodeAt(before - 1)) ? before - 1 : at;
      if (from < stop) { stop = Math.max(stop, far); if (chosen.replacement === REDACTED) replacement = REDACTED; }
      else {
        if (start !== -1) redacted += text.slice(copied, start) + replacement;
        if (start !== -1) copied = stop;
        start = from; stop = far; replacement = chosen.replacement;
      }
      // The scan goes on from the next character, not from the end of this match: a copy that overlaps this one
      // ("abab" in "ababab"), or starts where an escape can be read two ways, is found and joins the stretch.
    }
    if (start === -1) return cut < text.length ? text.slice(0, cut) : text;
    return redacted + text.slice(copied, start) + replacement + (stop < cut ? text.slice(stop, cut) : "");
  }
  /**
   * A copy of `value` with every match replaced, in strings and keys at any depth. Nothing is passed through for
   * its shape: what looks like an image is text a page can write too.
   * @template T @param {Matcher} known @param {T} value @returns {T}
   */
  function redactWith(known, value) {
    const copies = new Map();
    /** @param {unknown} node @returns {unknown} */
    const copy = (node) => {
      if (typeof node === "string") return redactTextWith(known, node);
      if (!node || typeof node !== "object" || ArrayBuffer.isView(node) || node instanceof ArrayBuffer || node instanceof Date) return node;
      if (copies.has(node)) return copies.get(node);
      /** @type {unknown[] | Record<string, unknown>} */
      const result = Array.isArray(node) ? [] : {};
      copies.set(node, result);
      for (const [key, item] of Object.entries(node)) {
        Object.defineProperty(result, Array.isArray(node) ? key : redactTextWith(known, key), { value: copy(item), enumerable: true, writable: true, configurable: true });
      }
      return result;
    };
    // A deep copy has the shape of its input; nothing narrower than `unknown` can be inferred through the walk.
    return /** @type {T} */ (copy(value));
  }

  return {
    /** @param {{ sessionId: string, label: string, kind: BrowserSecretKind, origins: string[], value: string }} input @returns {BrowserSecretSummary} */
    add({ sessionId, label, kind, origins, value }) {
      /** @param {string} message @returns {never} */
      const invalid = (message) => { throw new BrowserSecretError("invalid_secret", message); };
      if (typeof sessionId !== "string" || !sessionId) invalid("A secret belongs to one conversation. Open a conversation first.");
      const name = typeof label === "string" ? label.trim() : "";
      if (name.length < 1 || name.length > 80) invalid("Give the secret a name of 1 to 80 characters.");
      if (!SECRET_KINDS.includes(kind)) invalid("Choose what the secret is: a password, a code or a token.");
      if (typeof value !== "string" || value.length < 6 || value.length > 4096) invalid("The secret must be 6 to 4096 characters long.");
      if (Buffer.from(value, "utf8").toString("utf8") !== value) invalid("The secret has characters that cannot be sent to a website.");
      if (name.includes(value)) invalid("The name is shown to the agent, so it must not contain the secret.");
      if (!Array.isArray(origins) || origins.length < 1 || origins.length > 10) invalid("List 1 to 10 websites the secret may be sent to.");
      const sites = [...new Set(origins.map((origin) => siteOrigin(origin, invalid)))];
      const owned = sessions.get(sessionId) ?? new Map();
      if (owned.size >= maxPerSession) invalid(`A conversation can hold ${maxPerSession} secrets. Remove one first.`);
      /** @type {Secret} */
      const secret = { secretRef: `sec_${randomToken(22)}`, label: name, kind, origins: sites, value };
      owned.set(secret.secretRef, secret);
      sessions.set(sessionId, owned);
      if (!redacted.has(value)) { redacted.add(value); matcher = null; }
      return summary(secret);
    },
    /** @param {string} sessionId @returns {BrowserSecretSummary[]} */
    list: (sessionId) => [...sessions.get(sessionId)?.values() ?? []].map(summary),
    /**
     * Ends the secret: it is no longer listed or entered, and its placeholders are revoked. The value is not sent
     * anywhere again, but it stays in this store's memory, for redaction only, until the process ends: a site it
     * was sent to can still show it back. The requests rewritten with it stay guarded against a redirect.
     * @param {string} sessionId @param {string} secretRef
     */
    remove(sessionId, secretRef) {
      const owned = sessions.get(sessionId);
      if (!owned?.delete(secretRef)) return false;
      if (!owned.size) sessions.delete(sessionId);
      revoke((entry) => entry.sessionId === sessionId && entry.secretRef === secretRef, "removed");
      return true;
    },
    /** @param {string} sessionId */
    clearSession(sessionId) {
      sessions.delete(sessionId);
      revoke((entry) => entry.sessionId === sessionId, "removed");
    },
    /**
     * Ends every secret, placeholder and status. As with `remove`, the values stay in memory for redaction only, and
     * the requests that were rewritten stay guarded against a redirect.
     */
    clear() {
      sessions.clear();
      for (const [tabId, record] of [...tabs]) { record.entries = []; record.nextChange = -Infinity; settle(tabId); }
      schedule();
    },

    /** @param {string} sessionId @param {string} secretRef @returns {BrowserSecretSummary | null} */
    describe(sessionId, secretRef) {
      const secret = sessions.get(sessionId)?.get(secretRef);
      return secret ? summary(secret) : null;
    },
    /** @param {string} sessionId @param {string} pageOrigin @returns {{ secretRef: string, label: string, kind: BrowserSecretKind }[]} */
    availableFor: (sessionId, pageOrigin) => [...sessions.get(sessionId)?.values() ?? []].filter((secret) => secret.origins.includes(pageOrigin))
      .map(({ secretRef, label, kind }) => ({ secretRef, label, kind })),
    /**
     * A fresh placeholder for one field. The field's earlier placeholder in the same document stops working at once.
     * @param {{ sessionId: string, secretRef: string, tabId: string, origin: string, ref: string }} input @returns {{ placeholder: string }}
     */
    issue({ sessionId, secretRef, tabId, origin, ref }) {
      const secret = sessions.get(sessionId)?.get(secretRef);
      if (!secret) throw new BrowserSecretError("unknown_secret", "That secret does not exist in this conversation. Use a secretRef the page lists as available.");
      if (!secret.origins.includes(origin)) throw new BrowserSecretError("secret_not_allowed_here", "That secret is not allowed on this website.");
      if (typeof tabId !== "string" || !tabId || typeof ref !== "string" || !ref) throw new BrowserSecretError("invalid_request", "A secret is entered into one field of one tab.");
      settle(tabId);
      const record = tabs.get(tabId) ?? { generation: 0, entries: [], live: [], sent: [], rewritten: new Map(), unbound: [], nextChange: Infinity, announced: false, guarded: false };
      tabs.set(tabId, record);
      const placeholder = `${tag}${randomToken(PLACEHOLDER_LENGTH - TAG_LENGTH)}`;
      record.entries = record.entries.filter((entry) => entry.ref !== ref || entry.generation !== record.generation);
      record.entries.push({ placeholder, sessionId, secretRef, ref, generation: record.generation, expiresAt: now() + placeholderTtlMs,
        endedAt: null, endReason: null, sentTo: new Set(), reasons: new Set(), acted: false, missed: 0 });
      record.nextChange = -Infinity;
      settle(tabId);
      schedule();
      return { placeholder };
    },
    /**
     * The agent is about to click or press a key in the tab. From here on, a request with a body to an
     * allowed origin that does not carry a placeholder entered before this call counts as
     * `left_without_secret`; what was counted for an earlier click or key is forgotten.
     * @param {string} tabId
     */
    noteAction(tabId) {
      for (const entry of settle(tabId)) { entry.acted = true; entry.missed = 0; }
    },
    /**
     * The tab's top document changed. Its placeholders stop working at once: the document that follows, whatever
     * its origin, cannot spend one it was handed. A form that navigates sends its request before the new document
     * exists, so that request is already rewritten by now.
     * @param {string} tabId
     */
    documentChanged(tabId) {
      const record = tabs.get(tabId);
      if (record) record.generation++;
      revoke((_entry, owner) => owner === tabId, "expired");
    },
    /** @param {string} tabId */
    tabClosed(tabId) {
      const record = tabs.get(tabId);
      // A closed tab's requests are cancelled with it: nothing of it is left to redirect.
      if (record) { record.sent = []; record.rewritten.clear(); record.unbound = []; record.nextChange = -Infinity; }
      revoke((_entry, owner) => owner === tabId, "expired");
    },
    /** The host can no longer see this tab's requests: nothing of it is swapped from now on. @param {string} tabId */
    interceptionLost(tabId) { revoke((_entry, owner) => owner === tabId, "interception_lost"); },
    /** True while any placeholder of the tab can still be swapped. @param {string} tabId */
    live: (tabId) => settle(tabId).length > 0,
    /** @param {(tabId: string, live: boolean) => void} listener @returns {() => void} */
    onLiveChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /**
     * True while the host must see this tab's requests: a placeholder can still be swapped, or a request was
     * rewritten in the tab and can be redirected with the value in it, which holds until the tab closes. A host that
     * stops intercepting earlier must first know those requests are over, or cancel them.
     * @param {string} tabId
     */
    guarded(tabId) {
      settle(tabId);
      return tabs.get(tabId)?.guarded === true;
    },
    /** @param {(tabId: string, guarded: boolean) => void} listener @returns {() => void} */
    onGuardChange(listener) { guardListeners.add(listener); return () => { guardListeners.delete(listener); }; },
    /** What became of each secret entered in the tab. Never a value or a placeholder. @param {string} sessionId @param {string} tabId @returns {BrowserSecretStatus[]} */
    status(sessionId, tabId) {
      settle(tabId);
      return (tabs.get(tabId)?.entries ?? []).filter((entry) => entry.sessionId === sessionId).map((entry) => {
        if (entry.sentTo.size) return { secretRef: entry.secretRef, ref: entry.ref, state: "sent", sentTo: [...entry.sentTo] };
        const reason = SKIP_REASONS.find((skip) => entry.reasons.has(skip)) ?? (entry.missed > 0 ? "left_without_secret" : entry.endReason);
        return reason ? { secretRef: entry.secretRef, ref: entry.ref, state: "not_sent", reason } : { secretRef: entry.secretRef, ref: entry.ref, state: "pending" };
      });
    },

    /**
     * Decides one outgoing request of a tab: its own placeholders, and whether it replays what an earlier request
     * of the tab was rewritten to. Any failure inside fails the request.
     * @param {BrowserSecretRequest} input @returns {BrowserSecretDecision}
     */
    rewrite(input) {
      try {
        const live = settle(input?.tabId);
        const record = tabs.get(input?.tabId);
        return record ? decide(input, live, record) : CONTINUE;
      } catch { return FAIL; }
    },

    /**
     * A copy of `value` with every secret and every placeholder replaced, in each encoding listed above, in strings
     * and keys at any depth.
     * @template T @param {T} value @returns {T}
     */
    redact: (value) => redactWith(compiled(), value),
    /** @param {string} text @param {number} [limit] */
    redactText: (text, limit) => redactTextWith(compiled(), text, limit),
    /**
     * Redaction for one operation, taken when it starts. It knows the values of that moment and of the moment it
     * is used. `span` is how far past a cut a text must be read for `redactText(text, limit)`: no encoding of a secret or a
     * placeholder is longer. It is rounded up, and says nothing else about them.
     */
    redactor() {
      const then = compiled();
      const known = () => { const current = compiled(); return current === then ? then : compileMatcher(tag, [...then.values, ...current.values]); };
      return {
        span: then.span,
        /** @template T @param {T} value @returns {T} */
        redact: (value) => redactWith(known(), value),
        /** @param {string} text @param {number} [limit] */
        redactText: (text, limit) => redactTextWith(known(), text, limit),
      };
    },
  };
}

/**
 * The answer to one `Fetch.requestPaused` event of a tab, shared by both browser hosts. `readBody`
 * fetches a body the event does not carry whole and is only called while the tab is guarded. Never throws or rejects: a failure inside blocks the request.
 * @param {ReturnType<typeof createBrowserSecrets>} secrets @param {string} tabId
 * @param {{ requestId: string, redirectedRequestId?: string, networkId?: string, resourceType?: string, request: { url: string, method?: string, headers?: Record<string, string>, postData?: string, hasPostData?: boolean, postDataEntries?: { bytes?: string }[] } }} params
 * @param {{ readBody?: () => Promise<{ body: Uint8Array, complete: boolean }> }} [options]
 * @returns {Promise<{ method: "Fetch.continueRequest", params: { requestId: string, postData?: string, headers?: { name: string, value: string }[] } } | { method: "Fetch.failRequest", params: { requestId: string, errorReason: "BlockedByClient" } }>}
 */
export async function decidePausedRequest(secrets, tabId, params, { readBody } = {}) {
  const requestId = params?.requestId;
  try {
    if (!secrets.guarded(tabId)) return { method: "Fetch.continueRequest", params: { requestId } };
    const { request, resourceType } = params;
    const entries = Array.isArray(request.postDataEntries) ? request.postDataEntries : [];
    /** @type {Uint8Array | null} */
    let body = null;
    let bodyComplete = true;
    const chunks = entries.flatMap((entry) => typeof entry?.bytes === "string" ? [Buffer.from(entry.bytes, "base64")] : []);
    if (entries.length && chunks.length === entries.length) body = Buffer.concat(chunks);
    // The event's text form of a body cannot hold bytes that are not UTF-8: it shows them as U+FFFD.
    else if (typeof request.postData === "string" && !entries.length && !request.postData.includes("\ufffd")) body = Buffer.from(request.postData, "utf8");
    else if (request.hasPostData || entries.length || typeof request.postData === "string") {
      const read = readBody ? await Promise.resolve().then(readBody).catch(() => null) : null;
      body = read?.body ?? (typeof request.postData === "string" ? Buffer.from(request.postData, "utf8") : null);
      bodyComplete = read?.complete === true;
    }
    const named = (/** @type {unknown} */ id) => typeof id === "string" && id ? id : undefined;
    const decision = secrets.rewrite({ tabId, url: request.url, method: request.method, headers: request.headers, body, bodyComplete, resourceType,
      requestId: named(requestId), redirectOf: named(params.redirectedRequestId), networkId: named(params.networkId) });
    if (decision.action !== "continue") return { method: "Fetch.failRequest", params: { requestId, errorReason: "BlockedByClient" } };
    return { method: "Fetch.continueRequest", params: { requestId,
      ...(decision.body ? { postData: decision.body.toString("base64") } : {}),
      ...(decision.headers ? { headers: Object.entries(decision.headers).map(([name, value]) => ({ name, value: String(value) })) } : {}) } };
  } catch {
    return { method: "Fetch.failRequest", params: { requestId, errorReason: "BlockedByClient" } };
  }
}
