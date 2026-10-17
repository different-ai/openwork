#!/usr/bin/env node
// Internal fictional demo, not Microsoft's official Graph MCP server. Node builtins only:
// upload this file unchanged to a remote sandbox. No OAuth, credentials, external mail or persistence.
// HOST=127.0.0.1 PORT=3993 node demo-microsoft365.mjs
// Graph base /v1.0 (also /graph/v1.0); Bearer demo-microsoft365-token.
// /mcp is a standalone, unauthenticated DEMO MCP endpoint; expose only in a private demo sandbox.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3993);
const PUBLIC_ORIGIN = new URL(process.env.DEMO_PUBLIC_URL || `http://${HOST}:${PORT}`).origin;
const TOKEN = "demo-microsoft365-token";
const MAX_BODY = 10 * 1024 * 1024;
const MAX_TOTAL = 60 * 1024 * 1024;
const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
};
const ME = { id: "alex-chen", displayName: "Alex Chen", givenName: "Alex", surname: "Chen", mail: "alex@acme.test", userPrincipalName: "alex@acme.test", jobTitle: "CEO" };
const recipient = (address, name = address.split("@")[0]) => ({ emailAddress: { address, name } });
const ALEX = recipient(ME.mail, ME.displayName);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const unescape = (value) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, "&");
const strip = (text) => unescape(String(text).replace(/<[^>]*>/g, " ")).replace(/ +/g, " ").trim();
// Opt-in deterministic comparison clock/IDs; ordinary demo worlds retain wall-clock behavior.
const FIXED_NOW = process.env.DEMO_NOW ? Date.parse(process.env.DEMO_NOW) : undefined;
if (FIXED_NOW !== undefined && !Number.isFinite(FIXED_NOW)) throw new Error("DEMO_NOW must be an ISO timestamp.");
let sequence = 0;
const clock = () => FIXED_NOW ?? Date.now();
const now = () => new Date(clock()).toISOString();
const uuid = () => FIXED_NOW === undefined ? randomUUID() : `demo-${String(++sequence).padStart(6, "0")}`;
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (message) => new ApiError(400, "ErrorInvalidRequest", message);
const missing = () => new ApiError(404, "ErrorItemNotFound", "The requested demo item was not found.");
function object(value) { if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("Expected a JSON object."); return value; }
function text(value, label, max = 200000) { if (typeof value !== "string" || value.length > max) throw bad(`${label} must be text (maximum ${max} characters).`); return value; }
function addresses(value = []) {
  if (!Array.isArray(value) || value.length > 100) throw bad("Recipients must be an array of at most 100 emailAddress objects.");
  return value.map((entry) => {
    const email = object(object(entry).emailAddress); const address = text(email.address, "Email address", 254);
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new ApiError(400, "ErrorInvalidRecipients", "A recipient address is invalid.");
    return recipient(address, email.name === undefined ? address : text(email.name, "Recipient name", 254));
  });
}
function bodyValue(value = { contentType: "Text", content: "" }) {
  object(value); if (!["Text", "HTML", "text", "html"].includes(value.contentType)) throw bad("body.contentType must be Text or HTML.");
  return { contentType: value.contentType.toLowerCase() === "html" ? "HTML" : "Text", content: text(value.content, "Body") };
}

// Small, standards-based ZIP writer: stored entries, CRC32, local headers and central directory.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const chunks = []; const central = []; let offset = 0;
  for (const [path, xml] of Object.entries(entries)) {
    const name = Buffer.from(path); const data = Buffer.from(xml); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(33, 14);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    chunks.push(local, name, data); central.push(head, name); offset += local.length + name.length + data.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(central.reduce((sum, part) => sum + part.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function officePackage(main, type, entries, overrides = {}) {
  return zip({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries({ [main]: type, ...overrides }).map(([path, content]) => `<Override PartName="/${path}" ContentType="${content}"/>`).join("")}</Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="${main}"/></Relationships>`, ...entries,
  });
}
function docx(lines) {
  return officePackage("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", {
    "word/document.xml": `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map((line) => `<w:p><w:r><w:t xml:space="preserve">${escape(line)}</w:t></w:r></w:p>`).join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  });
}
function xlsx(rows) {
  return officePackage("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", {
    "xl/workbook.xml": `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE}"><sheets><sheet name="Pilot forecast" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((cell, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}"${typeof cell === "number" ? `><v>${cell}</v>` : ` t="inlineStr"><is><t>${escape(cell)}</t></is>`}</c>`).join("")}</row>`).join("")}</sheetData></worksheet>`,
  }, { "xl/worksheets/sheet1.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" });
}
function pptx(slides) {
  const entries = {
    "ppt/presentation.xml": `${XML}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OFFICE}"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `${XML}<Relationships xmlns="${REL}">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${OFFICE}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
  }; const overrides = {};
  slides.forEach((lines, i) => {
    const path = `ppt/slides/slide${i + 1}.xml`; overrides[path] = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
    entries[path] = `${XML}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Business content"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="700000" y="600000"/><a:ext cx="10700000" cy="5600000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${lines.map((line, n) => `<a:p><a:r><a:rPr lang="en-US" sz="${n ? 2200 : 3200}"/><a:t>${escape(line)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  });
  return officePackage("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", entries, overrides);
}

// Extract only bounded text-bearing XML parts. No XML entity expansion, links, HTML or macros execute.
function preview(bytes, name) {
  const extension = name.split(".").pop().toLowerCase();
  if (["txt", "md", "csv", "json", "log"].includes(extension)) return { text: bytes.subarray(0, 200000).toString("utf8"), kind: "Text", truncated: bytes.length > 200000 };
  if (!["docx", "xlsx", "pptx"].includes(extension)) return { text: "Preview unavailable for this file type. Download the original file.", kind: "Download only", truncated: false };
  try {
    const parts = []; let offset = 0; let expanded = 0; let count = 0;
    // Find the central directory, so data descriptors (normal Office uploads) also work.
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || end < bytes.length - 65557) throw bad("Invalid ZIP.");
    offset = bytes.readUInt32LE(end + 16); const total = bytes.readUInt16LE(end + 10);
    if (total > 2000) throw bad("Too many ZIP entries.");
    while (count++ < total) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) throw bad("Invalid ZIP directory.");
      const method = bytes.readUInt16LE(offset + 10); const size = bytes.readUInt32LE(offset + 20); const rawSize = bytes.readUInt32LE(offset + 24);
      const length = bytes.readUInt16LE(offset + 28); const path = bytes.subarray(offset + 46, offset + 46 + length).toString(); const local = bytes.readUInt32LE(offset + 42);
      offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
      if (!/^(word\/document|xl\/sharedStrings|xl\/worksheets\/sheet\d+|ppt\/slides\/slide\d+)\.xml$/.test(path)) continue;
      if (rawSize > 2000000 || expanded + rawSize > 4000000) throw bad("Preview extraction limit exceeded.");
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const packed = bytes.subarray(start, start + size);
      const data = method === 0 ? packed : method === 8 ? inflateRawSync(packed, { maxOutputLength: 2000000 }) : null;
      if (!data || data.length !== rawSize) throw bad("Unsupported ZIP entry."); expanded += data.length;
      const xml = data.toString("utf8");
      const content = unescape(xml.replace(/<\/(?:w:p|a:p|row)>/g, "\n").replace(/<\/c>/g, "\t").replace(/<[^>]+>/g, "")).trim();
      parts.push(`[${path}]\n${content}`);
    }
    const result = parts.join("\n\n");
    return { text: result.slice(0, 200000) || "No extractable text. Download the original file.", kind: "Extracted Office text (not an Office editor)", truncated: result.length > 200000 };
  } catch { return { text: "This Office file could not be safely previewed. Download the original file.", kind: "Download only", truncated: false }; }
}

let state;
let auditSequence = 0;
function auditCall(at, name, input, output, status) {
  // Snapshot actual provider values: later event/file mutations cannot rewrite provenance.
  state.audit.push(JSON.parse(JSON.stringify({ sequence: ++auditSequence, at, name: name ?? null, input, output, status })));
  if (state.audit.length > 1000) state.audit.shift();
}
function message(input = {}, draft = true) {
  object(input); const id = `mail-${uuid()}`; const body = bodyValue(input.body);
  return { id, conversationId: input.conversationId || `thread-${uuid()}`, subject: input.subject === undefined ? "" : text(input.subject, "Subject", 1000), body, bodyPreview: strip(body.content).slice(0, 255), from: ALEX, sender: ALEX, toRecipients: addresses(input.toRecipients), ccRecipients: addresses(input.ccRecipients), bccRecipients: addresses(input.bccRecipients), isDraft: draft, isRead: draft, hasAttachments: false, importance: "normal", categories: [], parentFolderId: draft ? "drafts" : "inbox", createdDateTime: now(), receivedDateTime: now(), lastModifiedDateTime: now(), webLink: `${PUBLIC_ORIGIN}/outlook?message=${id}` };
}
function putFile(path, bytes, contentType, existing) {
  text(path, "File path", 500); const segments = path.replace(/^\/+/, "").split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\x00-\x1f\\:*?"<>|]/.test(segment))) throw bad("Invalid file path.");
  const key = segments.join("/"); const item = existing || state.files.find((file) => file.path.toLowerCase() === key.toLowerCase());
  if (item?.folder) throw new ApiError(409, "nameAlreadyExists", "A folder already uses this path.");
  if (bytes.length > MAX_BODY || state.files.reduce((sum, file) => sum + (file.bytes?.length || 0), 0) - (item?.bytes.length || 0) + bytes.length > MAX_TOTAL) throw new ApiError(413, "quotaLimitReached", "Demo storage limit reached; reset the demo or use a smaller file.");
  // Real Graph requires parent folders to exist.
  const parentPath = segments.slice(0, -1).join("/"); const parent = parentPath ? state.files.find((file) => file.folder && file.path === parentPath) : null;
  if (parentPath && !parent) throw missing();
  const revision = (item?.revision || 0) + 1;
  const file = { id: item?.id || `file-${uuid()}`, name: segments.at(-1), path: key, bytes: Buffer.from(bytes), mime: contentType || MIME[segments.at(-1).split(".").pop().toLowerCase()] || "application/octet-stream", revision, eTag: `"${item?.id || createHash("sha256").update(key).digest("hex").slice(0, 12)},${revision}"`, createdDateTime: item?.createdDateTime || now(), lastModifiedDateTime: now(), parentId: parent?.id || "root" };
  if (item) state.files[state.files.indexOf(item)] = file; else state.files.push(file); return file;
}
function fileJson(file) {
  return { id: file.id, name: file.name, size: file.bytes?.length || 0, eTag: file.eTag, cTag: file.eTag, revision: file.revision, createdDateTime: file.createdDateTime, lastModifiedDateTime: file.lastModifiedDateTime, webUrl: `${PUBLIC_ORIGIN}/onedrive?item=${file.id}`, parentReference: { driveId: "acme-shared", id: file.parentId, path: `/drive/root:/${file.path.split("/").slice(0, -1).join("/")}` }, createdBy: { user: { displayName: "Alex Chen", email: ME.mail } }, lastModifiedBy: { user: { displayName: "Alex Chen", email: ME.mail } }, ...(file.folder ? { folder: { childCount: state.files.filter((child) => child.parentId === file.id).length } } : { file: { mimeType: file.mime, hashes: { sha256Hash: createHash("sha256").update(file.bytes).digest("hex") } }, "@microsoft.graph.downloadUrl": `${PUBLIC_ORIGIN}/download/${file.id}` }) };
}
// Graph dateTimeTimeZone values may be local wall times. This fixture supports IANA
// zones and these common Windows aliases, not Graph's complete timezone catalog.
const ZONE_ALIASES = { "Pacific Standard Time": "America/Los_Angeles", "Eastern Standard Time": "America/New_York", "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin", "Romance Standard Time": "Europe/Paris" };
function eventTime(value) {
  object(value); const date = text(value.dateTime, "dateTime", 64); const zone = text(value.timeZone, "timeZone", 100);
  const timeZone = ZONE_ALIASES[zone] || zone;
  let formatter;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); } catch { throw bad("Unsupported timeZone; use an IANA zone, UTC or a documented Windows alias in this demo."); }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,7})?)?(?:Z|[+-]\d\d:\d\d)?$/.test(date) || !Number.isFinite(Date.parse(date))) throw bad("Invalid dateTime.");
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(date)) return Date.parse(date);
  const wall = Date.parse(date + "Z"); let instant = wall;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const rendered = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) + ((instant % 1000) + 1000) % 1000;
    const adjustment = wall - rendered;
    if (!adjustment) return instant;
    instant += adjustment;
  }
  throw bad("Local dateTime does not exist in this timezone; supply an explicit offset.");
}
function event(input, existing) {
  object(input); const subject = text(input.subject, "Subject", 1000);
  if (eventTime(input.end) <= eventTime(input.start)) throw bad("Event end must be after start.");
  const id = existing?.id || `event-${uuid()}`; const body = bodyValue(input.body);
  if (input.attendees !== undefined && (!Array.isArray(input.attendees) || input.attendees.length > 100)) throw bad("attendees must be an array of at most 100 recipients.");
  const attendees = existing && input.attendees === existing.attendees ? existing.attendees : (input.attendees || []).map((entry) => {
    if (entry.type !== undefined && !["required", "optional", "resource"].includes(entry.type)) throw bad("Unsupported attendee type.");
    return { ...addresses([entry])[0], type: entry.type || "required", status: { response: "none", time: now() } };
  });
  return { id, subject, body, bodyPreview: strip(body.content).slice(0, 255), start: { dateTime: input.start.dateTime, timeZone: input.start.timeZone }, end: { dateTime: input.end.dateTime, timeZone: input.end.timeZone }, attendees, organizer: ALEX, location: { displayName: input.location ? text(object(input.location).displayName, "Location", 500) : "" }, isAllDay: input.isAllDay === true, isCancelled: false, showAs: "busy", createdDateTime: existing?.createdDateTime || now(), lastModifiedDateTime: now(), webLink: `${PUBLIC_ORIGIN}/outlook?event=${id}`, onlineMeeting: null };
}
function reset() {
  sequence = 0;
  auditSequence = 0;
  state = { messages: [], events: [], files: [], audit: [] };
  const addMail = (id, thread, subject, sender, content, hours, folder = "inbox") => {
    const item = message({ subject, body: { contentType: "Text", content }, toRecipients: [ALEX], conversationId: thread }, false);
    Object.assign(item, { id, from: recipient(sender[0], sender[1]), sender: recipient(sender[0], sender[1]), parentFolderId: folder, isRead: hours > 8, receivedDateTime: new Date(clock() - hours * 3600000).toISOString(), webLink: `${PUBLIC_ORIGIN}/outlook?message=${id}` }); state.messages.push(item);
  };
  addMail("mail-northwind-1", "thread-northwind", "Northwind | Atlas2 warehouse pilot readiness", ["liam@acme.test", "Liam O'Connor"], "Alex, Northwind's distribution team wants 12 Atlas2 units in the first wave. Acceptance: 98.5% mission completion, zero safety stops caused by navigation regressions, and a signed IT network checklist. Priya owns firmware 2.0-rc4 validation; Kenji owns site readiness. The open blocker is the Wi-Fi handoff test in aisle C. Please review Northwind-pilot-brief.docx before our customer meeting.", 30);
  addMail("mail-northwind-2", "thread-northwind", "RE: Northwind | Atlas2 warehouse pilot readiness", ["priya@acme.test", "Priya Shah"], "Firmware 2.0-rc4 passed 497 of 500 missions (99.4%) in the lab. The aisle C roaming test is still pending; do not call the pilot production-ready. Jamal will attach the field logs by Friday. The workbook separates committed units from the expansion option. Please keep the 24-unit option out of the committed forecast.", 5);
  addMail("mail-blueharbor-1", "thread-blueharbor", "Blue Harbor | AtlasLift safety review and customer meeting", ["mateo@acme.test", "Mateo Rivera"], "Blue Harbor is evaluating 8 AtlasLift units for pallet transfer. The customer meeting is tomorrow. Agenda: rated payload 1,200 kg, operator training, charging layout, and a two-week supervised pilot. Nora is updating the safety guide; Maya needs the pilot terms before we promise a date. Please bring Atlas-products-customer-review.pptx and the Pilot-forecast.xlsx workbook.", 4);
  addMail("mail-blueharbor-2", "thread-blueharbor", "RE: Blue Harbor | AtlasLift safety review and customer meeting", ["nora@acme.test", "Nora Patel"], "Safety-guide draft is ready for review. AtlasLift is rated for 1,200 kg on approved level-floor routes; the turning envelope and emergency-stop procedure need customer sign-off. Training is two sessions per shift. No unattended operation during the supervised pilot. Kenji will confirm the charging bay dimensions at the meeting.", 2);
  addMail("mail-finance", "thread-forecast", "Q4 pilot forecast: committed vs. expansion", ["sam@acme.test", "Sam Okafor"], "The committed forecast is 12 Atlas2 units for Northwind at $32,000 each and 8 AtlasLift units for Blue Harbor at $48,000 each: $768,000 total. Expansion options are not booked revenue. Northwind's additional 24 Atlas2 units would add $768,000 only after pilot acceptance. Update the shared workbook if dates change.", 10);
  addMail("mail-design", "thread-design", "Atlas2 fleet dashboard: customer feedback", ["morgan@acme.test", "Morgan Lee"], "The Northwind operators asked for a clearer blocked-mission explanation and battery status on the fleet overview. Ivy and I have a compact layout ready. Sofia is checking the telemetry labels against field data. The demo should show actual mission state rather than an optimistic placeholder.", 25);
  const draft = message({ subject: "Customer meeting follow-up — draft", toRecipients: [recipient("mateo@acme.test", "Mateo Rivera")], body: { contentType: "Text", content: "Mateo,\n\nAfter the Northwind and Blue Harbor customer meetings, please confirm the pilot acceptance owners and dates.\n\nAlex" } }); state.messages.push(draft);
  const day = new Date(clock()); day.setUTCDate(day.getUTCDate() + 1); day.setUTCHours(16, 0, 0, 0);
  state.events.push(event({ subject: "Northwind / Blue Harbor customer pilot review", start: { dateTime: day.toISOString(), timeZone: "UTC" }, end: { dateTime: new Date(day.getTime() + 3600000).toISOString(), timeZone: "UTC" }, attendees: [recipient("mateo@acme.test", "Mateo Rivera"), recipient("priya@acme.test", "Priya Shah"), recipient("nora@acme.test", "Nora Patel"), recipient("kenji@acme.test", "Kenji Tanaka")], location: { displayName: "Acme Robotics · customer briefing room" }, body: { contentType: "Text", content: "Fictional demo customer review. Northwind Atlas2 roaming test; Blue Harbor AtlasLift safety and training; forecast and next actions. Documents are in shared OneDrive." } }));
  const brief = ["Acme Robotics | Northwind pilot brief", "Fictional demo · Owner: Liam O'Connor · Engineering: Priya Shah · Field operations: Kenji Tanaka", "Product: Atlas2 autonomous mobile robot. Initial deployment: 12 units at $32,000 per unit ($384,000). Expansion option: 24 units, not committed.", "Acceptance gates: mission completion >=98.5%; approved safety checklist; IT network sign-off; operator training complete.", "Latest evidence: firmware 2.0-rc4 completed 497/500 lab missions (99.4%). This is lab evidence, not site acceptance.", "Open blocker: aisle C Wi-Fi roaming test. Jamal Brooks to provide field logs. Do not announce production readiness before validation.", "Customer meeting decisions: confirm the network-test owner, agree the two-week supervised pilot window, and assign acceptance sign-off.", "Next actions: Priya validates firmware; Kenji checks charging and network layout; Nora ships the operator guide; Mateo confirms commercial terms."];
  putFile("Northwind-pilot-brief.docx", docx(brief));
  putFile("Pilot-forecast.xlsx", xlsx([["Customer", "Product", "Stage", "Units", "Unit price USD", "Total USD", "Owner"], ["Northwind", "Atlas2", "Committed pilot", 12, 32000, 384000, "Liam O'Connor"], ["Blue Harbor", "AtlasLift", "Committed pilot", 8, 48000, 384000, "Mateo Rivera"], ["Northwind", "Atlas2", "Expansion option — not booked", 24, 32000, 768000, "Liam O'Connor"], ["Committed total", "", "", 20, "", 768000, "Sam Okafor"]]));
  putFile("Atlas-products-customer-review.pptx", pptx([["Acme Robotics | Customer pilot review", "Fictional demo · Alex Chen, Mateo Rivera, Priya Shah", "Two products: Atlas2 for autonomous tote transport; AtlasLift for pallet transfer.", "Decisions today: acceptance gates, site readiness, pilot owners."], ["Northwind | Atlas2", "12 committed units at $32,000 per unit.", "Lab: 497/500 successful missions (99.4%). Site acceptance still pending.", "Blocker: aisle C Wi-Fi handoff test. Owner: Priya Shah.", "24 additional units are an expansion option, not booked revenue."], ["Blue Harbor | AtlasLift", "8 committed pilot units at $48,000 per unit. Rated payload: 1,200 kg.", "Level-floor approved routes; supervised pilot only.", "Nora: safety guide. Kenji: charging layout and operator training.", "Next gate: customer safety sign-off and pilot terms review."]]));
  putFile("Blue-Harbor-safety-notes.txt", Buffer.from("Blue Harbor · AtlasLift supervised pilot\nFictional demo\nRated payload: 1,200 kg. Approved level-floor routes only.\nTwo operator-training sessions per shift. No unattended operation.\nNora Patel owns the safety guide; Kenji Tanaka confirms charging-bay dimensions.\nCustomer sign-off and Maya Singh's pilot terms review are still pending.\n"));
}
reset();

function findFile(id) { const file = state.files.find((entry) => entry.id === id); if (!file) throw missing(); return file; }
function findMessage(id) { const item = state.messages.find((entry) => entry.id === id); if (!item) throw missing(); return item; }
const folders = () => ["inbox", "drafts", "sentitems", "archive", "deleteditems"].map((id) => ({ id, displayName: ({ inbox: "Inbox", drafts: "Drafts", sentitems: "Sent Items", archive: "Archive", deleteditems: "Deleted Items" })[id], totalItemCount: state.messages.filter((m) => m.parentFolderId === id).length, unreadItemCount: state.messages.filter((m) => m.parentFolderId === id && !m.isRead).length, childFolderCount: 0 }));
function collection(items, url) {
  const top = Number(url.searchParams.get("$top") || 100); const skip = Number(url.searchParams.get("$skip") || 0);
  if (!Number.isInteger(top) || top < 1 || top > 1000 || !Number.isInteger(skip) || skip < 0) throw bad("$top must be 1–1000 and $skip a non-negative integer.");
  const result = { "@odata.context": "/v1.0/$metadata#demo", value: items.slice(skip, skip + top) };
  if (skip + top < items.length) { const next = new URL(url); next.searchParams.set("$skip", String(skip + top)); result["@odata.nextLink"] = next.pathname + next.search; }
  return result;
}
function searchMail(url, source = state.messages) {
  const raw = url.searchParams.get("$search") || ""; const query = raw.replace(/^"|"$/g, "").toLowerCase();
  let list = source.filter((entry) => `${entry.subject} ${entry.bodyPreview} ${entry.body.content} ${entry.from.emailAddress.address}`.toLowerCase().includes(query));
  const filter = url.searchParams.get("$filter");
  if (filter) {
    const read = filter.match(/^isRead eq (true|false)$/); const draft = filter.match(/^isDraft eq (true|false)$/); const thread = filter.match(/^conversationId eq '([^']+)'$/);
    if (read) list = list.filter((entry) => entry.isRead === (read[1] === "true"));
    else if (draft) list = list.filter((entry) => entry.isDraft === (draft[1] === "true"));
    else if (thread) list = list.filter((entry) => entry.conversationId === thread[1]);
    else throw bad("This demo supports isRead, isDraft or conversationId equality filters.");
  }
  return list.sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
}
function sendDraft(item) {
  if (!item.isDraft) throw new ApiError(400, "ErrorInvalidOperation", "Only a draft can be sent; this message was already sent or received.");
  if (!item.toRecipients.length && !item.ccRecipients.length && !item.bccRecipients.length) throw new ApiError(400, "ErrorInvalidRecipients", "Add at least one recipient before sending.");
  Object.assign(item, { isDraft: false, parentFolderId: "sentitems", sentDateTime: now(), lastModifiedDateTime: now(), isRead: true });
}
async function graph(method, path, url, input, bytes, headers = {}) {
  if (path === "/me" && method === "GET") return [200, ME];
  if (path === "/me/mailFolders" && method === "GET") return [200, collection(folders(), url)];
  const folder = path.match(/^\/me\/mailFolders\/([^/]+)(\/messages)?$/);
  if (folder && method === "GET") { const info = folders().find((entry) => entry.id === folder[1].toLowerCase()); if (!info) throw missing(); return [200, folder[2] ? collection(searchMail(url, state.messages.filter((item) => item.parentFolderId === info.id)), url) : info]; }
  if (path === "/me/messages") {
    if (method === "GET") return [200, collection(searchMail(url), url)];
    if (method === "POST") { const item = message(input); state.messages.push(item); return [201, item]; }
  }
  if (path === "/me/sendMail" && method === "POST") { const item = message(object(input).message); sendDraft(item); state.messages.push(item); return [202, null]; }
  const mail = path.match(/^\/me\/messages\/([^/]+)(?:\/(send|createReply|move))?$/);
  if (mail) {
    const item = findMessage(mail[1]);
    if (method === "GET" && !mail[2]) return [200, item];
    if (method === "POST" && mail[2] === "send") { sendDraft(item); return [202, null]; }
    if (method === "POST" && mail[2] === "createReply") {
      const draft = message({ subject: /^RE:/i.test(item.subject) ? item.subject : `RE: ${item.subject}`, conversationId: item.conversationId, toRecipients: [item.from], body: { contentType: "Text", content: input.comment || "" } }); state.messages.push(draft); return [201, draft];
    }
    if (method === "POST" && mail[2] === "move") { if (!folders().some((entry) => entry.id === input.destinationId)) throw bad("Unknown destinationId."); item.parentFolderId = input.destinationId; item.lastModifiedDateTime = now(); return [201, item]; }
    if (method === "PATCH" && !mail[2]) {
      object(input); const allowed = ["isRead", "categories", ...(item.isDraft ? ["subject", "body", "toRecipients", "ccRecipients", "bccRecipients"] : [])];
      if (Object.keys(input).some((key) => !allowed.includes(key))) throw bad("Only read state/categories can change on received or sent mail; compose fields require a draft.");
      const update = {};
      if (input.subject !== undefined) update.subject = text(input.subject, "Subject", 1000);
      if (input.body !== undefined) { update.body = bodyValue(input.body); update.bodyPreview = strip(update.body.content).slice(0, 255); }
      for (const key of ["toRecipients", "ccRecipients", "bccRecipients"]) if (input[key] !== undefined) update[key] = addresses(input[key]);
      if (input.isRead !== undefined) { if (typeof input.isRead !== "boolean") throw bad("isRead must be a boolean."); update.isRead = input.isRead; }
      if (input.categories !== undefined) { if (!Array.isArray(input.categories) || input.categories.length > 25) throw bad("categories must be an array of up to 25 strings."); update.categories = input.categories.map((value) => text(value, "Category", 100)); }
      Object.assign(item, update, { lastModifiedDateTime: now() }); return [200, item];
    }
  }
  if (["/me/events", "/me/calendar/events", "/me/calendarView"].includes(path)) {
    if (method === "GET") {
      const start = url.searchParams.get("startDateTime"); const end = url.searchParams.get("endDateTime");
      if ((start && !Number.isFinite(Date.parse(start))) || (end && !Number.isFinite(Date.parse(end)))) throw bad("Invalid calendar range.");
      return [200, collection(state.events.filter((entry) => (!start || eventTime(entry.end) > Date.parse(start)) && (!end || eventTime(entry.start) < Date.parse(end))), url)];
    }
    if (method === "POST" && path !== "/me/calendarView") { const item = event(input); state.events.push(item); return [201, item]; }
  }
  const eventMatch = path.match(/^\/me\/events\/([^/]+)$/);
  if (eventMatch) {
    const item = state.events.find((entry) => entry.id === eventMatch[1]); if (!item) throw missing();
    if (method === "GET") return [200, item];
    if (method === "DELETE") { state.events.splice(state.events.indexOf(item), 1); return [204, null]; }
    if (method === "PATCH") {
      object(input); const allowed = ["subject", "body", "start", "end", "attendees", "location", "isAllDay"];
      if (Object.keys(input).some((key) => !allowed.includes(key))) throw bad("This demo can update subject, body, start, end, attendees, location and isAllDay only.");
      const updated = event({ ...item, ...input }, item); Object.assign(item, updated); return [200, item];
    }
  }
  if (path === "/me/drive" && method === "GET") return [200, { id: "acme-shared", name: "Acme Robotics shared documents", driveType: "business", owner: { user: { displayName: "Acme Robotics" } } }];
  if (path === "/me/drive/root" && method === "GET") return [200, { id: "root", name: "Acme Robotics", folder: { childCount: state.files.filter((entry) => entry.parentId === "root").length } }];
  const search = path.match(/^\/me\/drive\/root\/search\(q='(.*)'\)$/);
  if (search && method === "GET") { const query = search[1].replace(/''/g, "'").toLowerCase(); return [200, collection(state.files.filter((entry) => entry.name.toLowerCase().includes(query)).map(fileJson), url)]; }
  const children = path.match(/^\/me\/drive\/(root|items\/([^/]+))\/children$/);
  if (children) {
    const parentId = children[2] || "root"; const parent = parentId === "root" ? null : findFile(parentId);
    if (parent && !parent.folder) throw bad("The requested item is not a folder.");
    if (method === "GET") return [200, collection(state.files.filter((entry) => entry.parentId === parentId).map(fileJson), url)];
    if (method === "POST") {
      object(input); if (!input.folder) throw bad("Use PUT content to upload a file, or include folder: {}."); const name = text(input.name, "Folder name", 255);
      if (!name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || [".", ".."].includes(name)) throw bad("Invalid folder name.");
      const folderPath = parent ? `${parent.path}/${name}` : name;
      if (state.files.some((entry) => entry.path.toLowerCase() === folderPath.toLowerCase())) throw new ApiError(409, "nameAlreadyExists", "An item with this name already exists.");
      const item = { id: `folder-${uuid()}`, name, path: folderPath, parentId, folder: true, revision: 1, eTag: `"${uuid()},1"`, createdDateTime: now(), lastModifiedDateTime: now() }; state.files.push(item); return [201, fileJson(item)];
    }
  }
  const byPath = path.match(/^\/me\/drive\/root:\/(.+?)(?::\/(content))?$/);
  const byId = path.match(/^\/me\/drive\/items\/([^/]+)(?:\/(content))?$/);
  if (byPath || byId) {
    const content = Boolean(byPath?.[2] || byId?.[2]);
    const file = byId ? findFile(byId[1]) : state.files.find((entry) => entry.path.toLowerCase() === byPath[1].toLowerCase());
    if (method === "PUT" && content) {
      if (headers["if-match"] && headers["if-match"] !== file?.eTag && headers["if-match"] !== "*") throw new ApiError(412, "preconditionFailed", "The file changed. Read the latest eTag before writing.");
      if (headers["if-match"] === "*" && !file) throw new ApiError(412, "preconditionFailed", "The file does not exist.");
      const updated = putFile(byPath?.[1] || file.path, bytes, headers["content-type"], file); return [file ? 200 : 201, fileJson(updated)];
    }
    if (!file) throw missing();
    if (method === "GET") { if (content && file.folder) throw bad("Folders have no content stream."); return content ? [200, file.bytes, { "content-type": file.mime, etag: file.eTag }] : [200, fileJson(file)]; }
  }
  throw new ApiError(404, "Request_ResourceNotFound", "This route is not available in the demo Graph service.");
}

const strSchema = { type: "string" };
function definition(name, description, properties, required, readOnly = true, destructive = false) {
  return { name, description: `DEMO ONLY — ${name.startsWith("file_") ? "OneDrive files and documents." : name.startsWith("calendar_") ? "Outlook calendar." : "Outlook mail and Inbox messages."} ${description} Fictional Acme Robotics data; not the official Microsoft Graph MCP.`, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { title: description.split(".")[0], readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: false } };
}
const calendarFields = {
  subject: strSchema,
  body: { anyOf: [strSchema, { type: "object", properties: { contentType: { type: "string", enum: ["Text", "HTML"] }, content: strSchema }, required: ["contentType", "content"], additionalProperties: false }], description: "Graph itemBody or plain text" },
  start: { anyOf: [strSchema, { type: "object", properties: { dateTime: strSchema, timeZone: strSchema }, required: ["dateTime", "timeZone"], additionalProperties: false }] },
  end: { anyOf: [strSchema, { type: "object", properties: { dateTime: strSchema, timeZone: strSchema }, required: ["dateTime", "timeZone"], additionalProperties: false }] },
  time_zone: { type: "string", description: "Zone for string start/end; defaults to UTC. IANA or Pacific/Eastern/GMT/W. Europe/Romance Standard Time." },
  location: strSchema,
  attendees: { type: "array", maxItems: 100, items: { anyOf: [strSchema, { type: "object", properties: { emailAddress: { type: "object", properties: { address: strSchema, name: strSchema }, required: ["address"], additionalProperties: false }, type: { type: "string", enum: ["required", "optional", "resource"] } }, required: ["emailAddress"], additionalProperties: false }] } },
};
function calendarInput(args) {
  const input = {};
  for (const key of ["subject", "body", "start", "end", "location", "attendees"]) {
    if (args[key] === undefined) continue;
    const value = args[key];
    input[key] = key === "body" && typeof value === "string" ? { contentType: "Text", content: value }
      : ["start", "end"].includes(key) && typeof value === "string" ? { dateTime: value, timeZone: args.time_zone || "UTC" }
      : key === "location" ? { displayName: value }
      : key === "attendees" ? value.map((entry) => typeof entry === "string" ? recipient(entry) : entry) : value;
  }
  if (args.time_zone !== undefined && !args.start && !args.end) throw bad("time_zone requires start or end.");
  return input;
}
const TOOLS = [
  definition("mail_search", "Search demo mail by text", { query: strSchema, folder: { type: "string", enum: ["inbox", "drafts", "sentitems", "archive", "deleteditems"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }, []),
  definition("mail_read", "Read a demo mail message", { message_id: strSchema }, ["message_id"]),
  definition("mail_create_draft", "Create a draft; does not send", { subject: strSchema, body: strSchema, to: { type: "array", items: strSchema, maxItems: 100 } }, ["subject", "body", "to"], false),
  definition("mail_create_reply_draft", "Create an unsent reply draft in an existing message conversation", { message_id: strSchema, body: strSchema }, ["message_id", "body"], false),
  definition("mail_send", "Move a draft into demo Sent Items; never delivers external email", { message_id: strSchema }, ["message_id"], false, true),
  definition("file_find", "Find shared demo files by filename", { query: strSchema }, []),
  definition("file_read", "Read file metadata, safe text extraction and original base64 bytes", { item_id: strSchema }, ["item_id"]),
  definition("file_create_folder", "Create a OneDrive folder under root or an existing parent folder ID", { name: strSchema, parent_id: strSchema }, ["name"], false),
  definition("file_write", "Create, upload or update a OneDrive document or file; pass content for text or content_base64 for binary, not both. Existing filenames are replaced; eTag guards revisions", { path: strSchema, content: strSchema, content_base64: strSchema, if_match: strSchema }, ["path"], false, true),
  definition("calendar_list", "List demo calendar events", { start: strSchema, end: strSchema }, []),
  definition("calendar_read", "Read a demo event by ID including agenda, attendees and timezone", { event_id: strSchema }, ["event_id"]),
  definition("calendar_create", "Create a demo event without sending real invitations. Graph dateTimeTimeZone/itemBody/attendee objects supported; string shorthand also accepted", calendarFields, ["subject", "start", "end"], false),
  definition("calendar_update", "Update or reschedule an existing demo event by ID. Omitted fields are preserved; no real invitations delivered", { event_id: strSchema, ...calendarFields }, ["event_id"], false),
];
async function callTool(name, args) {
  const tool = TOOLS.find((entry) => entry.name === name); if (!tool) throw bad(`Unknown demo tool: ${name}`); object(args);
  for (const key of tool.inputSchema.required) if (args[key] === undefined) throw bad(`Missing required argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[key]; if (!schema) throw bad(`Unknown argument: ${key}`);
    if (schema.type === "string") text(value, key, key === "content_base64" ? Math.ceil(MAX_BODY * 4 / 3) : MAX_BODY);
    if (schema.type === "integer" && (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)) throw bad(`Invalid ${key}.`);
    if (schema.type === "array" && (!Array.isArray(value) || value.length > schema.maxItems || (schema.items.type === "string" && value.some((entry) => typeof entry !== "string")))) throw bad(`Invalid ${key}.`);
    if (schema.enum && !schema.enum.includes(value)) throw bad(`Invalid ${key}.`);
  }
  const url = new URL("http://demo.local/v1.0/me");
  if (name === "mail_search") { url.searchParams.set("$search", args.query || ""); url.searchParams.set("$top", String(args.limit || 25)); return collection(searchMail(url, args.folder ? state.messages.filter((entry) => entry.parentFolderId === args.folder) : state.messages), url); }
  if (name === "mail_read") return findMessage(args.message_id);
  if (name === "mail_create_draft") { const item = message({ subject: args.subject, body: { contentType: "Text", content: args.body }, toRecipients: args.to.map((address) => recipient(address)) }); state.messages.push(item); return item; }
  if (name === "mail_create_reply_draft") return (await graph("POST", `/me/messages/${encodeURIComponent(args.message_id)}/createReply`, url, { comment: args.body }))[1];
  if (name === "mail_send") { const item = findMessage(args.message_id); sendDraft(item); return { id: item.id, status: "sent_in_demo_only", deliveredExternally: false }; }
  if (name === "file_find") return { value: state.files.filter((entry) => entry.name.toLowerCase().includes((args.query || "").toLowerCase())).map(fileJson) };
  if (name === "file_create_folder") return (await graph("POST", args.parent_id && args.parent_id !== "root" ? `/me/drive/items/${encodeURIComponent(args.parent_id)}/children` : "/me/drive/root/children", url, { name: args.name, folder: {} }))[1];
  if (name === "file_read") { const file = findFile(args.item_id); if (file.folder) return fileJson(file); return { ...fileJson(file), ...preview(file.bytes, file.name), content_base64: file.bytes.toString("base64") }; }
  if (name === "file_write") {
    if ((args.content === undefined) === (args.content_base64 === undefined)) throw bad("Provide exactly one of content or content_base64.");
    if (args.content_base64 !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.content_base64)) throw bad("Invalid base64 content.");
    const bytes = args.content !== undefined ? Buffer.from(args.content) : Buffer.from(args.content_base64, "base64");
    const result = await graph("PUT", `/me/drive/root:/${args.path.replace(/^\/+/, "")}:/content`, url, {}, bytes, args.if_match ? { "if-match": args.if_match } : {}); return result[1];
  }
  if (name === "calendar_list") { if (args.start) url.searchParams.set("startDateTime", args.start); if (args.end) url.searchParams.set("endDateTime", args.end); return (await graph("GET", "/me/calendarView", url, {}))[1]; }
  if (name === "calendar_read") return (await graph("GET", `/me/events/${encodeURIComponent(args.event_id)}`, url, {}))[1];
  if (name === "calendar_create") { const item = event(calendarInput(args)); state.events.push(item); return item; }
  if (name === "calendar_update") return (await graph("PATCH", `/me/events/${encodeURIComponent(args.event_id)}`, url, calendarInput(args)))[1];
}
async function rpc(payload) {
  object(payload); const { id, method, params = {} } = payload;
  if (payload.jsonrpc !== "2.0" || typeof method !== "string") return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
  if (id === undefined) return null;
  if (!params || typeof params !== "object" || Array.isArray(params)) return { jsonrpc: "2.0", id, error: { code: -32602, message: "params must be an object" } };
  const result = (value) => ({ jsonrpc: "2.0", id, result: value });
  if (method === "initialize") return result({ protocolVersion: ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].includes(params.protocolVersion) ? params.protocolVersion : "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "Acme Microsoft 365 DEMO (unofficial)", version: "1.0.0" }, instructions: "Fictional in-memory demo. Sending mail never delivers externally. Files and calendar are shared with the local demo browser surfaces. Not Microsoft's official MCP server." });
  if (method === "ping") return result({});
  if (method === "tools/list") return result({ tools: TOOLS });
  if (method === "tools/call") {
    const at = Date.now(); const input = params.arguments || {};
    try {
      const value = await callTool(params.name, input); const providerText = JSON.stringify(value);
      auditCall(at, params.name, input, JSON.parse(providerText), "completed");
      return result({ content: [{ type: "text", text: providerText }], isError: false });
    } catch (error) {
      const providerText = `${error.code || "DemoError"}: ${error.message}`;
      auditCall(at, params.name, input, providerText, "error");
      return result({ content: [{ type: "text", text: providerText }], isError: true });
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

// Native HTML controls are intentional here: this fixture is uploaded as a single file, without React/build tools.
// DESIGN P1/P6/S1/V1: compact rows, actual shared state, one reading pane; no pretend Office editor.
// Official layout/interaction references (internal fixture, not a shipped product feature):
// https://support.microsoft.com/en-us/office/get-help-with-outlook-on-the-web-cf659288-35cc-4c6c-8c75-e8e4317fda11
// https://support.microsoft.com/en-us/office/upload-and-save-files-and-folders-to-onedrive-a1397e56-61ec-4ed2-9dac-727bf8ac3357
// Outlook: folder tree, unread message list, reading pane and contextual command bar.
// OneDrive: upload into the current location, file list with metadata and read-only Office previews.
const UI_ICONS = {
  inbox: '<path d="M4 4h16v15H4zM4 12h5l2 3h2l2-3h5"/>',
  drafts: '<path d="M14 4H5v16h14v-9M12 12l8-8 2 2-8 8-3 1z"/>',
  sentitems: '<path d="m3 4 19 8-19 8 4-8zM7 12h15"/>',
  archive: '<path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6"/>',
  deleteditems: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M7 15h3M14 15h3"/>',
  folder: '<path d="M3 7V4h7l3 3h8v13H3z"/>',
  cloud: '<path d="M7 18a5 5 0 1 1 1-10 6 6 0 0 1 11 3 4 4 0 0 1-1 7z"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 17v4h16v-4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="m3 6 9 7 9-7"/>',
  reply: '<path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7"/>',
  home: '<path d="m3 11 9-8 9 8M5 9v12h5v-7h4v7h5V9"/>',
};
function uiIcon(name) { return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${UI_ICONS[name] || UI_ICONS.mail}</svg>`; }
function productLogo(drive) {
  return drive ? '<svg class="productlogo" viewBox="0 0 32 24" aria-hidden="true"><path fill="#0364b8" d="M12 18 7 8a10 10 0 0 1 18 2l-7 8z"/><path fill="#0078d4" d="M12 18 7 8a8 8 0 0 0-4 14z"/><path fill="#1490df" d="m12 18 13-8a7 7 0 0 1 5 12H3z"/><path fill="#28a8ea" d="m3 22 9-4 18 4z"/></svg>' : '<svg class="productlogo" viewBox="0 0 32 28" aria-hidden="true"><rect x="10" y="2" width="19" height="23" rx="2" fill="#28a8ea"/><path fill="#0078d4" d="m9 10 12 8 11-8v15H9z"/><path fill="#1490df" d="m9 25 12-9 11 9z"/><rect x="1" y="5" width="17" height="20" rx="1" fill="#185abd"/><text x="9.5" y="20" text-anchor="middle" fill="#fcfcfd" font-size="15" font-family="Segoe UI, sans-serif" font-weight="600">O</text></svg>';
}
function page(kind) {
  const drive = kind === "onedrive";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${drive ? "OneDrive" : "Outlook"} · Acme demo</title><style>
:root{--background:#fcfcfd;--muted:#f0f2f4;--border:#dfe3e6;--foreground:#1c2024;--secondary:#60646c;--primary:#011627;--accent:#e8eef4;--destructive:#b42318;--radius:.45rem}*{box-sizing:border-box}body{margin:0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--foreground);background:var(--background)}header{height:56px;display:flex;align-items:center;gap:24px;padding:0 20px;border-bottom:1px solid var(--border)}header strong{font-size:16px}a{color:var(--primary)}header small{margin-left:auto;color:var(--secondary)}nav{display:flex;flex-direction:column;gap:5px;padding:16px;background:var(--muted)}button,input,textarea{font:inherit;border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;background:var(--background);color:inherit}button{cursor:pointer}button:hover{background:var(--accent)}button[aria-current=true]{background:var(--accent);font-weight:600}button:disabled{cursor:wait;opacity:.6}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #3972a5;outline-offset:2px}.primary{background:var(--primary);color:var(--background)}.primary:hover{background:#17354a}main{display:grid;grid-template-columns:180px 330px minmax(300px,1fr);height:calc(100vh - 56px)}#listpane{border-right:1px solid var(--border);overflow:auto}#listpane>label{display:block;padding:12px;border-bottom:1px solid var(--border)}#search{width:100%}.row{display:block;text-align:left;width:100%;border:0;border-bottom:1px solid var(--border);border-radius:0;padding:12px 16px}.row strong,.row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row small,.muted{color:var(--secondary)}#detail{padding:24px;overflow:auto}h1{font-size:20px;letter-spacing:-.3px;margin:0 0 16px}h2{font-size:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 inherit}#mailbody{white-space:pre-wrap}form{max-width:700px}form label{display:block;margin:12px 0}form input,form textarea{display:block;width:100%;margin-top:5px}form textarea{min-height:240px}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:16px 0}#notice{position:fixed;bottom:16px;left:20px;max-width:calc(100vw - 40px);padding:8px 14px;background:var(--primary);color:var(--background);border-radius:var(--radius)}#notice:empty{display:none}#upload{max-width:100%;font-size:11px}dl{display:grid;grid-template-columns:100px 1fr;gap:6px}dt{color:var(--secondary)}dd{margin:0;overflow-wrap:anywhere}@media(max-width:850px){main{grid-template-columns:140px 260px minmax(300px,1fr);overflow:auto}header small{display:none}}@media(prefers-reduced-motion:no-preference){button{transition:background 120ms ease-out}}
/* Standalone fixture tokens: no runtime dependency on the desktop stylesheet. */
:root{--brand:#0f548c;--brand-soft:#e8f1fa;--canvas:#f5f5f5;--surface:#fcfcfd;--selected:#e8f1fa;--rail:#ebedef;--primary:#011627;--on-brand:#fcfcfd;--file-word:#185abd;--file-excel:#107c41;--file-powerpoint:#c43e1c}
header{height:48px;background:var(--brand);color:var(--on-brand);gap:18px;padding:0 16px}header strong{display:flex;align-items:center;gap:10px;font-size:17px}header a,header small{color:inherit}header a{text-decoration:none}header small{font-size:12px}.productlogo{width:28px;height:28px;flex-shrink:0}.account{width:30px;height:30px;display:grid;place-items:center;border:1px solid currentColor;border-radius:50%;font-size:11px}.icon{width:16px;height:16px;flex-shrink:0;vertical-align:middle}button .icon,a .icon{margin-right:8px}.workspace{display:grid;grid-template-columns:48px minmax(0,1fr);height:calc(100vh - 48px)}.apprail{padding:12px 0;align-items:center;gap:18px;background:var(--rail);border-right:1px solid var(--border)}.apprail a{display:grid;place-items:center;width:36px;height:36px;border-radius:var(--radius);text-decoration:none}.apprail a[aria-current=page]{background:var(--selected);color:var(--brand);box-shadow:inset 3px 0 var(--brand)}.apprail .icon{margin:0;width:20px;height:20px}main{height:100%;grid-template-columns:200px 350px minmax(300px,1fr);min-height:0;background:var(--canvas)}main>nav{padding:16px 8px;background:var(--canvas);border-right:1px solid var(--border)}.navtitle{font-weight:600;padding:12px}.navsection{color:var(--secondary);padding:12px 12px 4px;font-size:12px}#folders .row{display:flex;align-items:center;border:0;border-radius:var(--radius);padding:9px 12px;background:transparent;gap:9px}#folders .row[aria-current=true]{background:var(--selected);color:var(--brand)}.count{margin-left:auto;font-size:12px}.navfoot{margin-top:auto;padding:12px}.navfoot a{display:flex;align-items:center;text-decoration:none}.primary{background:var(--brand);border-color:var(--brand);color:var(--on-brand)}.primary:hover{background:var(--primary)}#listpane{background:var(--surface);min-width:0}#listpane>label{padding:12px 16px;font-size:12px}#search{margin-top:6px;background:var(--canvas)}.listheading{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border)}.listheading h1{margin:0;font-size:17px}.listheading select{max-width:105px}select{font:inherit;color:inherit;background:var(--surface);padding:5px;border:1px solid var(--border);border-radius:var(--radius)}.mailrow{padding:14px 16px;border-left:3px solid transparent;min-height:100px}.mailrow[aria-current=true]{background:var(--selected);border-left-color:var(--brand)}.mailrow.unread .sender,.mailrow.unread strong{font-weight:600}.mailrow.unread strong{color:var(--brand)}.senderline{display:flex;justify-content:space-between;gap:12px;margin-bottom:3px}.sender{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.senderline time{font-size:11px;color:var(--secondary);white-space:nowrap}.mailrow strong{font-weight:400;margin-bottom:3px}.unreaddot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--brand);margin-right:6px}#detail{padding:0;background:var(--surface);margin:12px;border:1px solid var(--border);border-radius:var(--radius)}#detail>h1,#detail>p,#detail>form,#detail>h2,#detail>dl,#detail>pre,#detail>#eventlist{margin:20px 24px}.commandbar{padding:10px 16px;border-bottom:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap}.commandbar button{background:transparent;border-color:transparent}.commandbar button:hover{background:var(--accent)}.messageheading{padding:20px 24px;border-bottom:1px solid var(--border)}.messageheading h1{margin:0 0 16px}.identity{display:flex;gap:12px;align-items:start}.avatar{border-radius:50%;background:var(--brand-soft);color:var(--brand);width:38px;height:38px;display:grid;place-items:center;flex-shrink:0;font-weight:600}.identity p{margin:0}.identity time{margin-left:auto;color:var(--secondary);font-size:12px}.address{color:var(--secondary);font-size:12px}.messagecontent{padding:28px 24px;max-width:860px;line-height:1.8}.messagecontent p{margin-top:0}.replyaction{margin:0 24px 24px}.drive main{grid-template-columns:200px minmax(450px,1fr) minmax(300px,420px)}.drive main:not(.has-preview){grid-template-columns:200px minmax(450px,1fr)}.drive main:not(.has-preview) #detail{display:none}.drive #listpane{border:0;padding:12px 24px}.drive #listpane>label{padding:8px 0 16px;max-width:520px;border:0}.drive .listheading{padding:16px 0}.filetable{width:100%;border-collapse:collapse;table-layout:fixed}.filetable th,.filetable td{padding:12px 8px;border-bottom:1px solid var(--border);text-align:left}.filetable th{font-size:12px;font-weight:500;color:var(--secondary)}.filetable th:first-child{width:55%}.filetable tr[aria-selected=true]{background:var(--selected)}.filetable td:first-child{display:flex;align-items:center;gap:10px}.filetable button{padding:0;border:0;background:transparent;text-align:left;overflow-wrap:anywhere}.filetable td:not(:first-child){font-size:12px;color:var(--secondary)}.filemark{display:inline-grid;place-items:center;width:26px;height:30px;background:var(--brand-soft);color:var(--brand);font-weight:600;border-radius:2px;flex-shrink:0}.filemark.docx{background:var(--file-word);color:var(--on-brand)}.filemark.xlsx{background:var(--file-excel);color:var(--on-brand)}.filemark.pptx{background:var(--file-powerpoint);color:var(--on-brand)}.uploadlabel{display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;cursor:pointer;background:var(--surface)}.uploadlabel input{position:absolute;width:1px;height:1px;opacity:0}.uploadlabel:focus-within{outline:2px solid var(--brand);outline-offset:2px}.uploadlabel .icon{margin-right:8px}.driveactions{display:flex;gap:8px;padding:12px 0;align-items:center}.driveactions label{margin:0}#backfolder{margin:8px 0}#filetext{background:var(--canvas);padding:16px;border-radius:var(--radius);font-family:ui-monospace,monospace;font-size:12px}.filemeta{display:flex;gap:16px;flex-wrap:wrap;color:var(--secondary);font-size:12px;margin:16px 24px}#notice:empty{display:none}#notice{max-width:600px;box-shadow:0 4px 20px #1c20241a}#notice[data-error=true]{color:var(--destructive)}@media(max-width:1100px){main{grid-template-columns:170px 290px minmax(260px,1fr)}.drive main{grid-template-columns:170px minmax(350px,1fr) 320px}header small{max-width:300px}}@media(max-width:800px){.workspace{grid-template-columns:40px 1fr}main,.drive main,.drive main:not(.has-preview){grid-template-columns:145px minmax(0,1fr);height:auto;min-height:100%}#detail{grid-column:2;min-height:320px}.drive #listpane{padding:8px 12px}header small{display:none}.filetable th:first-child{width:65%}.filetable th:last-child,.filetable td:last-child{display:none}}
</style></head><body class="${drive ? 'drive' : 'outlook'}"><header><strong>${productLogo(drive)}${drive ? "OneDrive" : "Outlook"}</strong><span>Acme Robotics</span><small>Fictional demo · No external delivery</small><span class="account" title="Alex Chen · alex@acme.test">AC</span></header><div class="workspace"><nav class="apprail" aria-label="Microsoft 365 demo apps"><a href="/outlook" aria-label="Outlook mail" ${!drive ? 'aria-current="page"' : ''}>${uiIcon('mail')}</a><a href="/outlook?view=calendar" aria-label="Outlook calendar">${uiIcon('calendar')}</a><a href="/onedrive" aria-label="OneDrive files" ${drive ? 'aria-current="page"' : ''}>${uiIcon('cloud')}</a></nav><main><nav aria-label="${drive ? "Files" : "Mail folders"}">${drive ? '<div class="navtitle">Alex Chen</div><button id="myfiles" aria-current="true">'+uiIcon('folder')+'My files</button><div class="navsection">Acme Robotics</div><div class="navtitle">Shared documents</div><button id="backfolder" hidden>Back to shared documents</button>' : '<button id="compose" class="primary">'+uiIcon('plus')+'New message</button><div class="navsection">Favorites</div><div id="folders"></div><button id="calendar">'+uiIcon('calendar')+'Open calendar</button>'}<div class="navfoot"><a href="/">${uiIcon('home')}Demo home</a></div></nav><section id="listpane" aria-label="${drive ? "File list" : "Message list"}"><label>Search ${drive ? "files" : "mail"}<input id="search" type="search" placeholder="${drive ? "Search filenames" : "Search subject or message"}"></label><div class="listheading"><h1 id="listtitle">${drive ? 'My files' : 'Inbox'}</h1><label>${drive ? 'Sort' : 'Show'} <select id="listfilter">${drive ? '<option value="name">Name</option><option value="modified">Modified</option>' : '<option value="all">All messages</option><option value="unread">Unread</option>'}</select></label></div>${drive ? '<div class="driveactions"><button id="newfolder" class="primary">'+uiIcon('plus')+'New folder</button><label class="uploadlabel">'+uiIcon('upload')+'Upload file<input id="upload" type="file"></label><button id="refreshlist">Refresh files</button></div><form id="folderform" hidden><label>Folder name<input id="foldername" required maxlength="255"></label><button class="primary">Create folder</button> <button id="cancelfolder" type="button">Cancel</button></form>' : ''}<div id="list"></div></section><section id="detail" aria-live="polite"><h1>${drive ? "Shared documents" : "Inbox"}</h1><p class="muted">${drive ? "Select a file to preview its contents." : "Select a message."}</p></section></main></div><div id="notice" role="status"></div><script>
const DRIVE=${drive};const TOKEN=${JSON.stringify(TOKEN)};let selected=new URLSearchParams(location.search).get(DRIVE?'item':'message');let folder='inbox',mode='read',draftId=null,lastSnapshot='',items=[],parentId='root',parentPath='';
const rendered=new Map();function rows(id,markup){if(rendered.get(id)!==markup){document.getElementById(id).innerHTML=markup;rendered.set(id,markup)}}
const $=id=>document.getElementById(id);const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ICONS=${JSON.stringify(UI_ICONS)};function icon(name){return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'+(ICONS[name]||ICONS.mail)+'</svg>'}function notice(message,error=false){$('notice').textContent=message;$('notice').dataset.error=String(error)}async function api(path,method='GET',body,raw=false){const headers={authorization:'Bearer '+TOKEN};if(!raw)headers['content-type']='application/json';const r=await fetch('/v1.0'+path,{method,headers,body:body===undefined?undefined:raw?body:JSON.stringify(body)});if(!r.ok){const e=await r.json();throw Error(e.error?.message||'Request failed')}return r.status===202||r.status===204?null:r.json()}
function fail(error){notice(error.message+' Try again.',true)}function mailAddresses(value){return (value||[]).map(x=>x.emailAddress.name+' <'+x.emailAddress.address+'>').join(', ')}
function fileMark(file){const ext=file.folder?'folder':file.name.split('.').pop().toLowerCase();return '<span class="filemark '+esc(ext)+'" aria-hidden="true">'+(file.folder?icon('folder'):({docx:'W',xlsx:'X',pptx:'P'})[ext]||icon('drafts'))+'</span>'}
async function render(){
 const q=$('search').value.toLowerCase();
 if(DRIVE){
  const files=(await api(q?"/me/drive/root/search(q='"+encodeURIComponent(q.replace(/'/g,"''"))+"')":parentId==='root'?'/me/drive/root/children':'/me/drive/items/'+parentId+'/children')).value;items=files;
  const visible=[...files].sort((a,b)=>Number(Boolean(b.folder))-Number(Boolean(a.folder))||($('listfilter').value==='modified'?b.lastModifiedDateTime.localeCompare(a.lastModifiedDateTime):a.name.localeCompare(b.name)));
  $('listtitle').textContent=q?'Search results':parentPath||'My files';
  rows('list',visible.length?'<table class="filetable"><thead><tr><th scope="col">Name</th><th scope="col">Modified</th><th scope="col">File size</th></tr></thead><tbody>'+visible.map(x=>'<tr aria-selected="'+(x.id===selected)+'"><td>'+fileMark(x)+'<button data-id="'+esc(x.id)+'">'+esc(x.name)+'</button></td><td>'+esc(new Date(x.lastModifiedDateTime).toLocaleDateString())+'<br>Alex Chen</td><td>'+(x.folder?x.folder.childCount+' items':x.size.toLocaleString()+' bytes')+'</td></tr>').join('')+'</tbody></table>':'<p class="muted" style="padding:16px">No matching files. Upload a file or clear the search.</p>');
  if(selected&&mode==='read'){const file=files.find(x=>x.id===selected)||await api('/me/drive/items/'+encodeURIComponent(selected));if(file){const snap=JSON.stringify(file);if(snap!==lastSnapshot){await showFile(file);lastSnapshot=snap}}}
 }else{
  const data=await api('/me/mailFolders');const current=data.value.find(f=>f.id===folder);$('listtitle').textContent=current.displayName;
  rows('folders',data.value.map(f=>'<button class="row" data-folder="'+f.id+'" aria-current="'+(folder===f.id)+'">'+icon(f.id)+'<span>'+esc(f.displayName)+'</span><span class="count" title="'+f.unreadItemCount+' unread, '+f.totalItemCount+' total">'+(f.id==='drafts'?f.totalItemCount:f.unreadItemCount||'')+'</span></button>').join(''));
  items=(await api('/me/mailFolders/'+folder+'/messages')).value;
  const visible=items.filter(x=>(x.subject+' '+x.body.content+' '+x.from.emailAddress.name+' '+x.from.emailAddress.address).toLowerCase().includes(q)&&($('listfilter').value!=='unread'||!x.isRead));
  rows('list',visible.length?visible.map(x=>'<button class="row mailrow '+(!x.isRead?'unread':'')+'" data-id="'+esc(x.id)+'" aria-current="'+(x.id===selected)+'"><span class="senderline"><span class="sender">'+(!x.isRead?'<span class="unreaddot" aria-label="Unread"></span>':'')+esc(x.isDraft?'Draft':x.from.emailAddress.name)+'</span><time>'+esc(new Date(x.receivedDateTime).toLocaleDateString())+'</time></span><strong>'+esc(x.subject||'(No subject)')+'</strong><small>'+esc(x.bodyPreview)+'</small></button>').join(''):'<p class="muted" style="padding:16px">No matching messages. Change folders or clear the search.</p>');
  if(selected&&mode==='read'){const item=await api('/me/messages/'+encodeURIComponent(selected));const snap=JSON.stringify(item);if(snap!==lastSnapshot){showMail(item);lastSnapshot=snap}}if(mode==='calendar')await renderCalendar()
 }
}
function showMail(m){
 const initials=m.from.emailAddress.name.split(' ').map(x=>x[0]).slice(0,2).join('');
 $('detail').innerHTML='<div class="commandbar">'+(m.parentFolderId!=='deleteditems'?'<button id="deletemail">'+icon('deleteditems')+'Delete</button>':'<button id="restoremail">'+icon('inbox')+'Move to Inbox</button>')+(m.parentFolderId!=='archive'?'<button id="archivemail">'+icon('archive')+'Archive</button>':'')+'<button id="toggleRead">'+icon('mail')+'Mark '+(m.isRead?'unread':'read')+'</button></div><div class="messageheading"><h1>'+esc(m.subject||'(No subject)')+'</h1><div class="identity"><span class="avatar">'+esc(initials)+'</span><div><p><strong>'+esc(m.from.emailAddress.name)+'</strong> <span class="address">&lt;'+esc(m.from.emailAddress.address)+'&gt;</span></p><p class="address">To: '+esc(mailAddresses(m.toRecipients))+'</p><p class="address">'+(m.isDraft?'Draft':m.parentFolderId==='sentitems'?'Sent in demo only — not externally delivered':m.isRead?'Read':'Unread')+'</p></div><time>'+esc(new Date(m.receivedDateTime).toLocaleString())+'</time></div></div><div id="mailbody" class="messagecontent"></div><div class="replyaction">'+(m.isDraft?'<button id="editdraft">'+icon('drafts')+'Edit draft</button>':'<button id="reply">'+icon('reply')+'Create reply draft</button>')+'</div>';
 $('mailbody').textContent=m.body.contentType==='HTML'?m.body.content.replace(/<[^>]*>/g,' '):m.body.content;
 if(m.isDraft)$('editdraft').onclick=()=>compose(m);else $('reply').onclick=async()=>{try{const r=await api('/me/messages/'+m.id+'/createReply','POST',{comment:''});folder='drafts';compose(r);await render()}catch(e){fail(e)}};
 $('toggleRead').onclick=async()=>{try{await api('/me/messages/'+m.id,'PATCH',{isRead:!m.isRead});await render()}catch(e){fail(e)}};
 async function move(destination){try{await api('/me/messages/'+m.id+'/move','POST',{destinationId:destination});selected=null;lastSnapshot='';$('detail').innerHTML='<h1>'+esc(({archive:'Archived',deleteditems:'Moved to Deleted Items',inbox:'Moved to Inbox'})[destination])+'</h1>';notice('Moved message to '+destination);await render()}catch(e){fail(e)}}
 if($('archivemail'))$('archivemail').onclick=()=>move('archive');if($('deletemail'))$('deletemail').onclick=()=>move('deleteditems');if($('restoremail'))$('restoremail').onclick=()=>move('inbox');
}
async function showFile(file){if(file.folder){parentId=file.id;parentPath=file.parentReference.path.replace('/drive/root:/','');parentPath=(parentPath?parentPath+'/':'')+file.name;selected=null;$('search').value='';$('backfolder').hidden=false;document.querySelector('main').classList.remove('has-preview');$('detail').innerHTML='<h1>'+esc(file.name)+'</h1><p class="muted">Select a file to preview its contents.</p>';await render();return}
 const r=await fetch('/preview/'+encodeURIComponent(file.id));if(!r.ok)throw Error('Could not preview this file');const p=await r.json();
 document.querySelector('main').classList.add('has-preview');
 $('detail').innerHTML='<div class="commandbar"><button id="closepreview">Close preview</button><a href="/download/'+encodeURIComponent(file.id)+'">'+icon('download')+'Download original file</a></div><h1>'+esc(file.name)+'</h1><p class="muted">'+esc(p.kind)+(p.truncated?' · Truncated preview':'')+'</p><div class="filemeta"><span>Revision '+file.revision+'</span><span>'+file.size.toLocaleString()+' bytes</span><span>Modified by Alex Chen</span></div>'+(p.kind==='Text'?'<div class="commandbar"><button id="edittext">Edit text file</button></div>':'<p class="muted">Read-only preview. Download to edit in Office.</p>')+'<pre id="filetext"></pre>';$('filetext').textContent=p.text;
 $('closepreview').onclick=()=>{selected=null;lastSnapshot='';document.querySelector('main').classList.remove('has-preview');history.replaceState(null,'',location.pathname);render().catch(fail)};
 if($('edittext'))$('edittext').onclick=()=>editText(file,p.text)
}
function editText(file,content){mode='editfile';$('detail').innerHTML='<h1>'+esc(file.name)+'</h1><form id="textform"><label>Text contents<textarea id="filecontents"></textarea></label><button class="primary">Save changes</button> <button id="canceltext" type="button">Cancel editing</button></form>';$('filecontents').value=content;$('canceltext').onclick=()=>{mode='read';lastSnapshot='';render().catch(fail)};$('textform').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/v1.0/me/drive/items/'+file.id+'/content',{method:'PUT',headers:{authorization:'Bearer '+TOKEN,'content-type':file.file.mimeType,'if-match':file.eTag},body:$('filecontents').value});if(!r.ok)throw Error((await r.json()).error.message);mode='read';lastSnapshot='';notice('Saved changes');await render()}catch(e){fail(e)}}}
function compose(m){mode='compose';draftId=m?.id||null;selected=draftId;$('detail').innerHTML='<h1>'+(m?'Edit draft':'New message')+'</h1><form id="composeform"><label>To (comma-separated email addresses)<input id="to" type="text" required></label><label>Subject<input id="subject" maxlength="1000"></label><label>Message<textarea id="body"></textarea></label><div class="actions"><button type="submit">Save draft</button><button type="button" id="send" class="primary">Send in demo only</button><button type="button" id="closecompose">Close compose</button></div></form>';$('to').value=(m?.toRecipients||[]).map(x=>x.emailAddress.address).join(', ');$('subject').value=m?.subject||'';$('body').value=m?.body.content||'';$('to').focus();$('closecompose').onclick=()=>{if(!confirm('Close compose? Unsaved changes will be lost.'))return;mode='read';lastSnapshot='';$('detail').innerHTML='<h1>Inbox</h1>';render().catch(fail)};async function save(){const payload={subject:$('subject').value,body:{contentType:'Text',content:$('body').value},toRecipients:$('to').value.split(',').map(x=>x.trim()).filter(Boolean).map(address=>({emailAddress:{address}}))};const m=await api(draftId?'/me/messages/'+draftId:'/me/messages',draftId?'PATCH':'POST',payload);draftId=m.id;selected=m.id;folder='drafts';notice('Saved draft');await render();return m}let busy=false;async function action(send){if(busy)return;busy=true;try{if(send&&!confirm('Send this message in the fictional demo? No external email will be delivered.'))return;await save();if(send){await api('/me/messages/'+draftId+'/send','POST',{});mode='read';folder='sentitems';lastSnapshot='';notice('Sent in demo only — no external delivery');await render()}}catch(e){fail(e)}finally{busy=false}}$('composeform').onsubmit=e=>{e.preventDefault();action(false)};$('send').onclick=()=>action(true)}
async function renderCalendar(){const events=(await api('/me/events')).value;const list=$('eventlist');const eventId=new URLSearchParams(location.search).get('event');if(list)rows('eventlist',events.length?events.filter(e=>!eventId||e.id===eventId).map(e=>'<article data-event-id="'+esc(e.id)+'"><h2><a href="'+esc(e.webLink)+'">'+esc(e.subject)+'</a></h2><p>'+esc(e.start.dateTime)+' — '+esc(e.end.dateTime)+'</p><p>'+esc(e.start.timeZone)+(e.end.timeZone!==e.start.timeZone?' / '+esc(e.end.timeZone):'')+'</p><p>'+esc(e.location.displayName)+'</p><p class="muted">'+esc(mailAddresses(e.attendees))+'</p><pre>'+esc(e.body.contentType==='HTML'?e.body.content.replace(/<[^>]*>/g,' '):e.body.content)+'</pre></article>').join(''):'<p>No events. Create a demo event below.</p>')}
async function calendar(){mode='calendar';$('detail').innerHTML='<h1>Calendar</h1><div id="eventlist"></div><h2>Create demo event</h2><form id="eventform"><label>Subject<input id="eventsubject" required></label><label>Start (local time)<input id="eventstart" type="datetime-local" required></label><label>End (local time)<input id="eventend" type="datetime-local" required></label><label>Location<input id="eventlocation"></label><button class="primary">Create event</button></form>';$('eventform').onsubmit=async e=>{e.preventDefault();try{await api('/me/events','POST',{subject:$('eventsubject').value,start:{dateTime:new Date($('eventstart').value).toISOString(),timeZone:'UTC'},end:{dateTime:new Date($('eventend').value).toISOString(),timeZone:'UTC'},location:{displayName:$('eventlocation').value}});$('eventform').reset();notice('Created demo event — no invitations delivered');await renderCalendar()}catch(e){fail(e)}};await renderCalendar()}
$('list').onclick=async e=>{const row=e.target.closest('[data-id]');if(!row)return;if(mode==='compose'&&!confirm('Leave compose? Unsaved changes will be lost.'))return;selected=row.dataset.id;mode='read';lastSnapshot='';if(!DRIVE){const item=items.find(x=>x.id===selected);if(item&&!item.isRead)try{await api('/me/messages/'+selected,'PATCH',{isRead:true})}catch(e){fail(e)}}history.replaceState(null,'',location.pathname+'?'+(DRIVE?'item=':'message=')+encodeURIComponent(selected));render().catch(fail)};$('search').oninput=()=>render().catch(fail);
$('listfilter').onchange=()=>render().catch(fail);
if(DRIVE){function rootFolder(){parentId='root';parentPath='';selected=null;lastSnapshot='';$('search').value='';$('backfolder').hidden=true;document.querySelector('main').classList.remove('has-preview');history.replaceState(null,'',location.pathname);$('detail').innerHTML='<h1>Shared documents</h1>';render().catch(fail)}$('backfolder').onclick=rootFolder;$('myfiles').onclick=rootFolder;$('refreshlist').onclick=()=>render().catch(fail);$('newfolder').onclick=()=>{$('folderform').hidden=false;$('foldername').focus()};$('cancelfolder').onclick=()=>{$('folderform').hidden=true;$('folderform').reset()};$('folderform').onsubmit=async e=>{e.preventDefault();try{const created=await api(parentId==='root'?'/me/drive/root/children':'/me/drive/items/'+parentId+'/children','POST',{name:$('foldername').value,folder:{}});$('folderform').reset();$('folderform').hidden=true;notice('Created folder '+created.name);await render()}catch(e){fail(e)}};$('upload').onchange=async()=>{const file=$('upload').files[0];if(!file)return;try{if(file.size>10485760)throw Error('Upload limit is 10 MB');if(items.some(x=>x.name.toLowerCase()===file.name.toLowerCase())&&!confirm('Replace the existing shared file '+file.name+'?'))return;const r=await fetch('/v1.0/me/drive/root:/'+(parentPath?parentPath.split('/').map(encodeURIComponent).join('/')+'/':'')+encodeURIComponent(file.name)+':/content',{method:'PUT',headers:{authorization:'Bearer '+TOKEN,'content-type':file.type||'application/octet-stream'},body:file});if(!r.ok)throw Error((await r.json()).error.message);const item=await r.json();selected=item.id;lastSnapshot='';notice('Uploaded '+file.name);await render()}catch(e){fail(e)}finally{$('upload').value=''}}}else{$('compose').onclick=()=>{if(mode==='compose'&&!confirm('Start another message? Unsaved changes will be lost.'))return;compose()};$('calendar').onclick=()=>{if(mode==='compose'&&!confirm('Leave compose? Unsaved changes will be lost.'))return;calendar().catch(fail)};$('folders').onclick=e=>{const button=e.target.closest('[data-folder]');if(!button)return;if(mode==='compose'&&!confirm('Leave compose? Unsaved changes will be lost.'))return;folder=button.dataset.folder;selected=null;mode='read';$('detail').innerHTML='<h1>'+esc(button.textContent)+'</h1>';render().catch(fail)}}
let refreshing=false;async function refresh(){if(refreshing)return;refreshing=true;try{await render()}catch(e){fail(e)}finally{refreshing=false}}refresh();if(!DRIVE&&(new URLSearchParams(location.search).get('view')==='calendar'||new URLSearchParams(location.search).has('event')))calendar().catch(fail);setInterval(refresh,1800);
</script></body></html>`;
}

function send(response, status, value, headers = {}) {
  const binary = Buffer.isBuffer(value); const contentType = binary ? "application/octet-stream" : typeof value === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8";
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", ...headers });
  response.end(value === null || status === 204 ? undefined : binary || typeof value === "string" ? value : JSON.stringify(value));
}
async function readBody(request) {
  const chunks = []; let size = 0;
  if (Number(request.headers["content-length"]) > MAX_BODY) throw new ApiError(413, "RequestEntityTooLarge", "Maximum request size is 10 MB.");
  for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) throw new ApiError(413, "RequestEntityTooLarge", "Maximum request size is 10 MB."); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.headers.origin && request.headers.origin !== url.origin) throw new ApiError(403, "accessDenied", "Cross-origin demo requests are not allowed.");
    if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true, service: "demo-microsoft365", fictional: true, externalDelivery: false });
    if (request.method === "GET" && url.pathname === "/state") return send(response, 200, { fictional: true, user: ME, audit: state.audit, folders: folders(), messages: state.messages, events: state.events, files: state.files.map((file) => ({ ...fileJson(file), ...(!file.folder ? { preview: preview(file.bytes, file.name) } : {}) })) });
    if (request.method === "POST" && url.pathname === "/reset") { await readBody(request); reset(); return send(response, 200, { reset: true }); }
    if (request.method === "GET" && url.pathname === "/") return send(response, 200, '<!doctype html><html lang="en"><meta charset="utf-8"><title>Acme Microsoft 365 demo</title><body style="font:14px/1.6 system-ui;margin:48px"><h1>Acme Robotics · Microsoft 365 demo</h1><p>Fictional in-memory data. Mail and invitations are never delivered externally.</p><p><a href="/outlook">Open Outlook mail & calendar</a></p><p><a href="/onedrive">Open OneDrive shared files</a></p><details><summary>Demo connection details</summary><p>Standalone unofficial MCP: <code>/mcp</code>. Graph-shaped REST: <code>/v1.0</code>. Synthetic Bearer token: <code>demo-microsoft365-token</code>.</p><p>Restarting or POST /reset restores the seed. Upload limit: 10 MB per file, 60 MB total. Private demo use only; not production authentication.</p></details></body></html>');
    if (request.method === "GET" && ["/outlook", "/onedrive"].includes(url.pathname)) return send(response, 200, page(url.pathname.slice(1)));
    const publicFile = url.pathname.match(/^\/(download|preview)\/([^/]+)$/);
    if (publicFile && request.method === "GET") { const file = findFile(decodeURIComponent(publicFile[2])); if (file.folder) throw bad("Select a file, not a folder."); return publicFile[1] === "preview" ? send(response, 200, preview(file.bytes, file.name)) : send(response, 200, file.bytes, { "content-type": file.mime, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, etag: file.eTag }); }
    if (url.pathname === "/mcp") {
      if (request.method === "GET") return send(response, 405, { error: "This stateless DEMO MCP accepts POST JSON-RPC; SSE is not required." }, { allow: "POST, DELETE" });
      if (request.method === "DELETE") return send(response, 204, null);
      if (request.method !== "POST") throw new ApiError(405, "methodNotAllowed", "Use POST.");
      let payload; try { payload = JSON.parse((await readBody(request)).toString()); } catch (error) { if (error.status) throw error; return send(response, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      if (Array.isArray(payload)) throw bad("JSON-RPC batches are not supported."); const result = await rpc(payload); return send(response, result === null ? 202 : 200, result);
    }
    const prefix = url.pathname.startsWith("/graph/v1.0/") ? "/graph/v1.0" : "/v1.0";
    if (!url.pathname.startsWith(`${prefix}/`)) throw missing();
    if (request.headers.authorization !== `Bearer ${TOKEN}`) throw new ApiError(401, "InvalidAuthenticationToken", "Use the synthetic demo Bearer token, not a real Microsoft credential.");
    const bytes = ["POST", "PATCH", "PUT"].includes(request.method) ? await readBody(request) : Buffer.alloc(0);
    let path; try { path = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { throw bad("The request path contains invalid URL encoding."); }
    let input = {};
    if (bytes.length && request.method !== "PUT") { try { input = object(JSON.parse(bytes.toString())); } catch (error) { if (error.status) throw error; throw bad("Invalid JSON request body."); } }
    const [status, value, headers] = await graph(request.method, path, url, input, bytes, request.headers); return send(response, status, value, headers);
  } catch (error) { send(response, error.status || 500, { error: { code: error.code || "InternalServerError", message: error.status ? error.message : "The demo request failed.", innerError: { "request-id": randomUUID(), date: now() } } }); }
});
server.requestTimeout = 30000; server.headersTimeout = 15000; server.maxRequestsPerSocket = 1000;
server.listen(PORT, HOST, () => console.log(`Demo Microsoft 365 listening at http://${HOST}:${server.address().port} (fictional, in-memory; /outlook /onedrive /mcp /v1.0)`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(); server.closeAllConnections(); });
