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
/** @typedef {{ tabId: string, url: string, method?: string, headers?: Record<string, string>, body?: Uint8Array | null, bodyComplete?: boolean, resourceType?: string }} BrowserSecretRequest */
/** @typedef {BrowserSecretSummary & { value: string }} Secret */
/** @typedef {{ placeholder: string, sessionId: string, secretRef: string, ref: string, generation: number, expiresAt: number,
 *   endedAt: number | null, endReason: string | null, sentTo: Set<string>, reasons: Set<string>, missed: number }} Entry */
/** @typedef {{ generation: number, entries: Entry[], live: Entry[], nextChange: number, announced: boolean }} TabRecord */
/** @typedef {{ point: string, bytes: number[] }} Unit one code point of a value and its UTF-8 bytes */
/** @typedef {{ replacement: string, widen: boolean, match: (text: string, at: number) => number[] | null }} Candidate `match` gives every offset the encoding can end at */
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
const PNG_BASE64 = "iVBORw0KGgo";
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
  for (const value of swaps.values.values()) if (/[\r\n]/.test(value) || value.includes(String(boundary))) throw new Error("value cannot sit in multipart");
  let inParts = 0;
  for (const part of parts) {
    const content = body.subarray(part.start, part.end);
    const held = placeholdersIn(content, swaps);
    if (!held) continue;
    inParts += held;
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

// Redaction. A value is recognised raw and in each encoding a page or a server commonly echoes it
// in. A text is scanned once: two adjacent characters select the few encodings that can start
// there, and each is then checked character by character, so cost grows with the text, not with
// the number or the length of the secrets.
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
 * Where one character of a value can end when it starts at `at`: raw, `+` for a space,
 * percent-encoded bytes, a JSON escape, or an HTML character reference.
 * @param {string} text @param {number} at @param {Unit} unit @param {number[]} ends
 */
function unitEnds(text, at, unit, ends) {
  const point = unit.point, code = text.charCodeAt(at);
  if (text.startsWith(point, at)) reach(ends, at + point.length);
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
/** Every offset where `units`, matched from `at`, can end; null when they do not match. @param {string} text @param {number} at @param {Unit[]} units */
function matchUnits(text, at, units) {
  let ends = [at];
  for (const unit of units) {
    const code = ends.length === 1 ? text.charCodeAt(ends[0]) : -1;
    // Away from an escape character only the raw spelling can match: no list is built.
    if (code !== -1 && code !== 37 && code !== 92 && code !== 38 && code !== 43) {
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
  return heads;
}
/** The end of a fixed text matched in either of two alphabets (hex in both cases, base64 and base64url), or -1. @param {string} text @param {number} at @param {string} first @param {string} second */
function matchEither(text, at, first, second) {
  for (let index = 0; index < first.length; index++) {
    const code = text.charCodeAt(at + index);
    if (code !== first.charCodeAt(index) && code !== second.charCodeAt(index)) return -1;
  }
  return at + first.length;
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
  register([tag.charCodeAt(0)], [tag.charCodeAt(1)], { replacement: REDACTED_PLACEHOLDER, widen: false, match(text, at) {
    if (!text.startsWith(tag, at)) return null;
    for (let index = at + TAG_LENGTH; index < at + PLACEHOLDER_LENGTH; index++) if (!alphanumeric(text.charCodeAt(index))) return null;
    return [at + PLACEHOLDER_LENGTH];
  } });
  for (const value of [...new Set(values)].sort((a, b) => b.length - a.length)) {
    const units = Array.from(value, (point) => ({ point, bytes: [...Buffer.from(point, "utf8")] }));
    const following = unitHeads(units[1]).flatMap(([first]) => first);
    /** @type {Candidate} */
    const spelled = { replacement: REDACTED, widen: false, match: (text, at) => matchUnits(text, at, units) };
    for (const [first, second] of unitHeads(units[0])) register(first, second ?? following, spelled);
    const bytes = Buffer.from(value, "utf8");
    const hex = bytes.toString("hex"), upper = hex.toUpperCase();
    register([hex.charCodeAt(0), upper.charCodeAt(0)], [hex.charCodeAt(1), upper.charCodeAt(1)], { replacement: REDACTED, widen: false, match(text, at) {
      const end = matchEither(text, at, hex, upper);
      return end === -1 ? null : [end];
    } });
    // Base64 of the value inside a longer text ("name:password") depends on where the value starts
    // in its group of three bytes. The characters that hold only the value's bits are matched; the
    // one on each side that mixes them with a neighbour's bits is taken with the match.
    for (let lead = 0; lead < 3; lead++) {
      const encoded = Buffer.concat([Buffer.alloc(lead), bytes]).toString("base64").replace(/=+$/, "");
      const partial = (lead + bytes.length) % 3 !== 0;
      const middle = encoded.slice([0, 2, 3][lead], partial ? -1 : undefined);
      const urlSafe = middle.replaceAll("+", "-").replaceAll("/", "_");
      register([middle.charCodeAt(0), urlSafe.charCodeAt(0)], [middle.charCodeAt(1), urlSafe.charCodeAt(1)], { replacement: REDACTED, widen: lead > 0, match(text, at) {
        let end = matchEither(text, at, middle, urlSafe);
        if (end === -1) return null;
        if (partial && base64Code(text.charCodeAt(end))) end++;
        for (let padding = 0; partial && padding < 2 && text.charCodeAt(end) === 61; padding++) end++;
        return [end];
      } });
    }
  }
  return { ascii, pairs, wide };
}

/**
 * @param {{ allowLoopbackHttp?: boolean, placeholderTtlMs?: number, lingerMs?: number, maxPerSession?: number, now?: () => number }} [options]
 * `now` is the clock expiry is measured on; tests pass their own.
 */
export function createBrowserSecrets({ allowLoopbackHttp = false, placeholderTtlMs = 300_000, lingerMs = 15_000, maxPerSession = 20, now = Date.now } = {}) {
  // A placeholder starts with a letter, so it is never JSON on its own.
  const tag = `${ALPHABET[randomBytes(1)[0] % 52]}${randomToken(TAG_LENGTH - 1)}`;
  /** @type {Map<string, Map<string, Secret>>} */
  const sessions = new Map();
  /** @type {Map<string, TabRecord>} */
  const tabs = new Map();
  /** @type {Set<(tabId: string, live: boolean) => void>} */
  const listeners = new Set();
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
    if (!record.entries.length) tabs.delete(tabId);
    const live = record.live.length > 0;
    if (live !== record.announced) {
      record.announced = live;
      // One listener failing must not stop the others or the store.
      for (const listener of [...listeners]) try { listener(tabId, live); } catch {}
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

  /** @param {BrowserSecretRequest} input @param {Entry[]} entries @param {Buffer | null} body */
  function countMissed(input, entries, body) {
    if (!entries.length || !body?.length || input.bodyComplete === false || UNCOUNTED_RESOURCES.has(String(input.resourceType))) return;
    if (["GET", "HEAD"].includes(String(input.method).toUpperCase())) return;
    const origin = originOf(input.url)?.origin;
    if (origin) for (const entry of entries) if (secretOf(entry)?.origins.includes(origin)) entry.missed++;
  }

  /** The origin a value may be swapped into for this request, or null. @param {BrowserSecretRequest} input */
  function destinationOf(input) {
    const target = originOf(input.url);
    return target && input.resourceType !== "WebSocket" && (target.protocol === "https:" || allowLoopbackHttp && loopbackHttp(target)) ? target.origin : null;
  }
  /**
   * Chromium follows a 307 or 308 redirect with the body the host rewrote, so the next hop arrives
   * holding the value, not the placeholder. True when this request would take a value this tab
   * already sent to an origin that secret is not allowed for.
   * @param {Entry[]} live @param {string | null} destination @param {[string, unknown][]} headers @param {Buffer | null} body
   */
  function carriesValueElsewhere(live, destination, headers, body) {
    for (const entry of live) {
      const secret = entry.sentTo.size ? secretOf(entry) : undefined;
      if (!secret || destination && secret.origins.includes(destination)) continue;
      for (const spelling of new Set([secret.value, jsonEscaped(secret.value), formEncoded(secret.value)])) {
        if (body?.includes(spelling) || headers.some(([, value]) => typeof value === "string" && value.includes(spelling))) return true;
      }
    }
    return false;
  }

  /** @param {BrowserSecretRequest} input @param {Entry[]} live @returns {BrowserSecretDecision} */
  function decide(input, live) {
    const url = input.url;
    const headers = Object.entries(input.headers ?? {});
    const body = asBuffer(input.body);
    const sent = live.some((entry) => entry.sentTo.size > 0);
    if (sent && carriesValueElsewhere(live, destinationOf(input), headers, body)) return FAIL;
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
      return { action: "continue", ...changes };
    } catch {
      for (const { entry } of allowed) entry.reasons.add("unsupported_encoding");
      return FAIL;
    }
  }

  /** @param {string} text */
  function redactText(text) {
    if (typeof text !== "string" || text.length < 6) return text;
    matcher ??= compileMatcher(tag, [...sessions.values()].flatMap((owned) => [...owned.values()].map((secret) => secret.value)));
    const { ascii, pairs, wide } = matcher;
    // One stretch of text to replace: matches that overlap it extend it.
    let redacted = "", copied = 0, start = -1, stop = -1, replacement = "";
    for (let at = 0, last = text.length - 1; at < last;) {
      const first = text.charCodeAt(at), second = text.charCodeAt(at + 1);
      const candidates = (first < 128 && second < 128 ? ascii[first << 7 | second] === 1 : wide) ? pairs.get(first * 65536 + second) : undefined;
      let far = -1, near = Infinity, chosen = null;
      if (candidates) for (const candidate of candidates) {
        const ends = candidate.match(text, at);
        if (!ends) continue;
        near = Math.min(near, ...ends);
        // The longest encoding that matches here wins, so no tail of a longer secret is left behind.
        if (Math.max(...ends) > far) { far = Math.max(...ends); chosen = candidate; }
      }
      if (!chosen) { at++; continue; }
      const from = chosen.widen && at > 0 && base64Code(text.charCodeAt(at - 1)) ? at - 1 : at;
      if (from < stop) { stop = Math.max(stop, far); if (chosen.replacement === REDACTED) replacement = REDACTED; }
      else {
        if (start !== -1) redacted += text.slice(copied, start) + replacement;
        if (start !== -1) copied = stop;
        start = from; stop = far; replacement = chosen.replacement;
      }
      // Where an escape can be read two ways ("\\" ends one value or starts the next), the scan goes on from the
      // nearest end, so a second copy right behind the first is still found.
      at = near;
    }
    return start === -1 ? text : redacted + text.slice(copied, start) + replacement + text.slice(stop);
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
      matcher = null;
      return summary(secret);
    },
    /** @param {string} sessionId @returns {BrowserSecretSummary[]} */
    list: (sessionId) => [...sessions.get(sessionId)?.values() ?? []].map(summary),
    /** Forgets the value and revokes its placeholders. @param {string} sessionId @param {string} secretRef */
    remove(sessionId, secretRef) {
      const owned = sessions.get(sessionId);
      if (!owned?.delete(secretRef)) return false;
      if (!owned.size) sessions.delete(sessionId);
      matcher = null;
      revoke((entry) => entry.sessionId === sessionId && entry.secretRef === secretRef, "removed");
      return true;
    },
    /** @param {string} sessionId */
    clearSession(sessionId) {
      if (sessions.delete(sessionId)) matcher = null;
      revoke((entry) => entry.sessionId === sessionId, "removed");
    },
    /** Forgets every value, placeholder and status. */
    clear() {
      sessions.clear();
      matcher = null;
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
      const record = tabs.get(tabId) ?? { generation: 0, entries: [], live: [], nextChange: Infinity, announced: false };
      tabs.set(tabId, record);
      const placeholder = `${tag}${randomToken(PLACEHOLDER_LENGTH - TAG_LENGTH)}`;
      record.entries = record.entries.filter((entry) => entry.ref !== ref || entry.generation !== record.generation);
      record.entries.push({ placeholder, sessionId, secretRef, ref, generation: record.generation, expiresAt: now() + placeholderTtlMs,
        endedAt: null, endReason: null, sentTo: new Set(), reasons: new Set(), missed: 0 });
      record.nextChange = -Infinity;
      settle(tabId);
      schedule();
      return { placeholder };
    },
    /** The tab's top document changed: requests already on their way may still carry its placeholders for `lingerMs`. @param {string} tabId */
    documentChanged(tabId) {
      const record = tabs.get(tabId);
      if (!record) return;
      const until = now() + lingerMs;
      record.generation++;
      for (const entry of record.live) entry.expiresAt = Math.min(entry.expiresAt, until);
      record.nextChange = -Infinity;
      settle(tabId);
      schedule();
    },
    /** @param {string} tabId */
    tabClosed(tabId) { revoke((_entry, owner) => owner === tabId, "expired"); },
    /** The host can no longer see this tab's requests: nothing of it is swapped from now on. @param {string} tabId */
    interceptionLost(tabId) { revoke((_entry, owner) => owner === tabId, "interception_lost"); },
    /** True while any placeholder of the tab can still be swapped. @param {string} tabId */
    live: (tabId) => settle(tabId).length > 0,
    /** @param {(tabId: string, live: boolean) => void} listener @returns {() => void} */
    onLiveChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
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
     * Decides one outgoing request of a tab, judged on this request alone. Any failure inside fails the request.
     * @param {BrowserSecretRequest} input @returns {BrowserSecretDecision}
     */
    rewrite(input) {
      try {
        const live = settle(input?.tabId);
        return live.length ? decide(input, live) : CONTINUE;
      } catch { return FAIL; }
    },

    /**
     * A copy of `value` with every secret, in each encoding listed above, and every placeholder
     * replaced, in strings and keys at any depth. Only a PNG at `image.data` is passed through.
     * @template T @param {T} value @returns {T}
     */
    redact(value) {
      const copies = new Map();
      /** @param {unknown} node @param {boolean} image @returns {unknown} */
      const copy = (node, image) => {
        if (typeof node === "string") return redactText(node);
        if (!node || typeof node !== "object" || ArrayBuffer.isView(node) || node instanceof ArrayBuffer || node instanceof Date) return node;
        if (copies.has(node)) return copies.get(node);
        /** @type {unknown[] | Record<string, unknown>} */
        const result = Array.isArray(node) ? [] : {};
        copies.set(node, result);
        for (const [key, item] of Object.entries(node)) {
          const kept = image && key === "data" && typeof item === "string" && item.startsWith(PNG_BASE64);
          Object.defineProperty(result, Array.isArray(node) ? key : redactText(key), { value: kept ? item : copy(item, key === "image"), enumerable: true, writable: true, configurable: true });
        }
        return result;
      };
      // A deep copy has the shape of its input; nothing narrower than `unknown` can be inferred through the walk.
      return /** @type {T} */ (copy(value, false));
    },
    redactText,
  };
}

/**
 * The answer to one `Fetch.requestPaused` event of a tab, shared by both browser hosts. `readBody`
 * fetches a body the event does not carry whole and is only called while the tab has a live
 * placeholder. Never throws or rejects: a failure inside blocks the request.
 * @param {ReturnType<typeof createBrowserSecrets>} secrets @param {string} tabId
 * @param {{ requestId: string, resourceType?: string, request: { url: string, method?: string, headers?: Record<string, string>, postData?: string, hasPostData?: boolean, postDataEntries?: { bytes?: string }[] } }} params
 * @param {{ readBody?: () => Promise<{ body: Uint8Array, complete: boolean }> }} [options]
 * @returns {Promise<{ method: "Fetch.continueRequest", params: { requestId: string, postData?: string, headers?: { name: string, value: string }[] } } | { method: "Fetch.failRequest", params: { requestId: string, errorReason: "BlockedByClient" } }>}
 */
export async function decidePausedRequest(secrets, tabId, params, { readBody } = {}) {
  const requestId = params?.requestId;
  try {
    if (!secrets.live(tabId)) return { method: "Fetch.continueRequest", params: { requestId } };
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
    const decision = secrets.rewrite({ tabId, url: request.url, method: request.method, headers: request.headers, body, bodyComplete, resourceType });
    if (decision.action !== "continue") return { method: "Fetch.failRequest", params: { requestId, errorReason: "BlockedByClient" } };
    return { method: "Fetch.continueRequest", params: { requestId,
      ...(decision.body ? { postData: decision.body.toString("base64") } : {}),
      ...(decision.headers ? { headers: Object.entries(decision.headers).map(([name, value]) => ({ name, value: String(value) })) } : {}) } };
  } catch {
    return { method: "Fetch.failRequest", params: { requestId, errorReason: "BlockedByClient" } };
  }
}
