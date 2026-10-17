#!/usr/bin/env node
// Isolated deterministic fictional news corpus, not a news provider or inference runner.
// Simulated daily due-job infrastructure only. No external requests, email, filesystem
// delivery or model execution. Operator receipts attest external evidence, not fixture verification.
import { createServer } from "node:http";
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3994);
const SEED_NOW = process.env.DEMO_NOW || "2026-10-16T15:55:00Z";
if (!Number.isFinite(Date.parse(SEED_NOW))) throw new Error("Invalid DEMO_NOW");
const STORIES = [
  ["fr-grid", "France", "France opens a community battery pilot", "Civic Energy Review", "Three fictional municipalities will test shared storage. The six-month trial measures peak demand; no nationwide savings have been demonstrated."],
  ["fr-rail", "France", "Regional rail adds an accessibility trial", "Transit Ledger", "Two fictional stations begin step-free boarding tests. The operator will publish passenger feedback after eight weeks."],
  ["us-storage", "United States", "University team publishes recyclable battery research", "Science Dispatch", "A fictional laboratory reports 200 prototype charge cycles. Commercial durability and manufacturing costs remain unverified."],
  ["us-freight", "United States", "Port starts an electric freight corridor pilot", "Logistics Journal", "A fictional port will trial ten electric trucks for three months. Charging capacity and journey times are the evaluation criteria."],
  ["de-heat", "Germany", "District heating cooperative begins heat-pump tests", "Industry Observer", "A fictional cooperative connects forty homes to a shared heat pump. Winter performance is not yet known."],
  ["de-skills", "Germany", "Technical colleges launch robotics retraining cohort", "Workforce Weekly", "A fictional regional program enrolls sixty workers. Completion and placement results will be reported next quarter."],
  ["jp-resilience", "Japan", "Coastal town tests emergency microgrid", "Regional Resilience", "A fictional town begins a controlled backup-power exercise at its clinic. The test is not evidence of disaster readiness across the country."],
  ["jp-delivery", "Japan", "Hospital starts supervised delivery-robot trial", "Health Systems Ledger", "A fictional hospital tests two robots carrying sealed supplies. Staff supervise every route; patient-facing deployment is out of scope."],
].map(([id, country, title, outlet, summary], index) => ({ id, country, title, outlet, summary, body: `${summary} This story is synthetic workshop source material, not a report of a real event.`, publishedAt: `2026-10-16T0${7 + index % 2}:00:00Z`, url: `https://workshop-news.example/articles/${id}` }));
let state;
let auditSequence = 0;
function auditCall(at, name, input, output, status) {
  state.audit.push(JSON.parse(JSON.stringify({ sequence: ++auditSequence, at, name: name ?? null, input, output, status })));
  if (state.audit.length > 1000) state.audit.shift();
}
function reset() { auditSequence = 0; state = { fictional: true, now: new Date(SEED_NOW).toISOString(), articles: STORIES, corpus: STORIES, clockEvents: [], jobs: [], events: [], audit: [], isolatedDueJobs: true, productionScheduler: false, inferenceRunner: false, inferenceExecuted: false, deliveryExecuted: false }; }
const TIME_ZONE = "America/Los_Angeles";
const LOCAL = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function localParts(instant) { return Object.fromEntries(LOCAL.formatToParts(new Date(instant)).map((part) => [part.type, part.value])); }
function nextDue(after, hour, minute) {
  const parts = localParts(after);
  const localDay = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  for (let day = 0; day < 4; day++) {
    const wall = localDay + day * 86400000 + hour * 3600000 + minute * 60000;
    let instant = wall;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = localParts(instant);
      const rendered = Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day), Number(current.hour), Number(current.minute), Number(current.second));
      const adjustment = wall - rendered;
      if (!adjustment) { if (instant > after) return new Date(instant).toISOString(); break; }
      instant += adjustment;
    }
    // A nonexistent spring-forward wall time is skipped, not silently shifted.
  }
  throw Error("Could not resolve next daily occurrence");
}
function advanceClock(now) {
  const target = Date.parse(now);
  if (typeof now !== "string" || !Number.isFinite(target) || target < Date.parse(state.now)) throw Error("Clock must advance to an ISO timestamp");
  const events = []; const updates = [];
  for (const job of state.jobs) {
    let dueAt = job.nextDueAt;
    while (Date.parse(dueAt) <= target) {
      if (state.events.length + events.length >= 1000) throw Error("Due-event limit reached; reset the isolated fixture");
      events.push({ id: `event-${state.events.length + events.length + 1}`, jobId: job.id, dueAt, status: "due", inferenceExecuted: false, deliveryExecuted: false, executionReceipt: null });
      dueAt = nextDue(Date.parse(dueAt), job.hour, job.minute);
    }
    updates.push([job, dueAt]);
  }
  for (const [job, dueAt] of updates) job.nextDueAt = dueAt;
  state.now = new Date(target).toISOString(); state.events.push(...events);
  state.clockEvents.push({ id: `clock-${state.clockEvents.length + 1}`, now: state.now, dueEventIds: events.map((event) => event.id), inferenceExecuted: false, deliveryExecuted: false });
  return events;
}
reset();
const string = { type: "string" };
const definition = (name, description, properties, required, readOnly = true) => ({ name, description: `FICTIONAL FIXTURE ONLY — ${description}`, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } });
const TOOLS = [
  definition("news_list", "List the fixed synthetic corpus metadata: titles, summaries, country, outlet and .example links. No external news or search network.", {}, []),
  definition("news_search", "Search the fixed synthetic corpus by query/country; no external news or search network.", { query: string, country: string }, []),
  definition("news_read", "Read a complete synthetic article by its ID or exact .example link. Links are identifiers consumed here, not live websites.", { article: string }, ["article"]),
  definition("news_schedule_create", "Register an isolated SIMULATED daily job, saving your instructions for an external runner. Only America/Los_Angeles is supported. Does NOT read news, generate a digest, call a model or deliver anything. The operator advances the clock and dispatches real inference separately when due.", { name: string, hour: { type: "integer", minimum: 0, maximum: 23 }, minute: { type: "integer", minimum: 0, maximum: 59 }, time_zone: { type: "string", enum: [TIME_ZONE] }, instructions: string }, ["name", "hour", "minute", "time_zone", "instructions"], false),
  definition("news_schedule_list", "Read actual isolated daily jobs and due events. A due event is NOT evidence of inference or delivery. Operator receipts must be checked against external real-model/backend evidence.", {}, []),
];
function call(name, args) {
  const tool = TOOLS.find((tool) => tool.name === name);
  if (!tool) throw Error("Unknown fixture tool");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("Expected arguments object");
  for (const key of tool.inputSchema.required) if (args[key] === undefined) throw Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[key];
    if (!schema || (schema.type === "integer" ? !Number.isInteger(value) || value < schema.minimum || value > schema.maximum : typeof value !== "string" || value.length > 20000) || (schema.enum && !schema.enum.includes(value))) throw Error(`Invalid ${key}`);
  }
  if (name === "news_schedule_create") {
    if (!args.name.trim() || !args.instructions.trim()) throw Error("Name and instructions must not be empty");
    if (state.jobs.length >= 100) throw Error("Job limit reached; reset the isolated fixture");
    const job = { id: `job-${state.jobs.length + 1}`, ...args, recurrence: "daily", createdAt: state.now, nextDueAt: nextDue(Date.parse(state.now), args.hour, args.minute), executionReceipts: [], isolatedDueJobs: true, productionScheduler: false, inferenceExecuted: false, deliveryExecuted: false };
    state.jobs.push(job); return job;
  }
  if (name === "news_schedule_list") return { jobs: state.jobs, events: state.events, now: state.now, isolatedDueJobs: true, productionScheduler: false, inferenceRunner: false };
  if (name === "news_list" || name === "news_search") return { fictional: true, value: STORIES.filter((article) => (!args.country || article.country.toLowerCase() === args.country.toLowerCase()) && (!args.query || `${article.title} ${article.summary} ${article.country} ${article.outlet}`.toLowerCase().includes(args.query.toLowerCase()))).map(({ body, ...article }) => article) };
  const article = STORIES.find((article) => article.id === args.article || article.url === args.article);
  if (!article) throw Error("Article not found in the fixed corpus");
  return { fictional: true, ...article };
}
async function read(request) { let text = ""; for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 65536) throw Error("Body too large"); } return text ? JSON.parse(text) : {}; }
const server = createServer(async (request, response) => {
  const send = (status, value) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(value === null ? undefined : JSON.stringify(value)); };
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.headers.origin && request.headers.origin !== url.origin) return send(403, { error: "Cross-origin requests denied" });
    if (request.method === "GET" && url.pathname === "/health") return send(200, { ok: true, fictional: true, service: "demo-workshop-news", inferenceRunner: false, isolatedDueJobs: true, productionScheduler: false, externalNetwork: false });
    if (request.method === "GET" && url.pathname === "/state") return send(200, state);
    if (request.method === "POST" && url.pathname === "/reset") { await read(request); reset(); return send(200, state); }
    // Operator clock emits real isolated due events, but does NOT tick Den or run inference.
    if (request.method === "POST" && url.pathname === "/clock") {
      const input = await read(request); const dueEvents = advanceClock(input.now);
      return send(200, { ...state, dueEvents });
    }
    if (request.method === "POST" && url.pathname === "/execution-receipt") {
      const token = process.env.WORKSHOP_OPERATOR_TOKEN;
      if (!token || request.headers["x-workshop-operator-token"] !== token) return send(403, { error: "Operator authorization required" });
      const input = await read(request);
      const fields = ["eventId", "sessionId", "digestFileId", "draftId", "inferenceWitnessSequence"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== fields.length || Object.keys(input).some((key) => !fields.includes(key))) throw Error("Provide only the five receipt fields");
      for (const key of fields.slice(0, 4)) if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 500) throw Error(`Invalid ${key}`);
      if (!Number.isSafeInteger(input.inferenceWitnessSequence) || input.inferenceWitnessSequence < 1) throw Error("Invalid inferenceWitnessSequence");
      const event = state.events.find((entry) => entry.id === input.eventId);
      if (!event) throw Error("Due event not found");
      if (event.executionReceipt) throw Error("An execution receipt is already recorded for this event");
      // This service cannot independently verify those external records. The private
      // operator must first verify paid inference and actual backend artifact evidence.
      const receipt = { ...input, recordedAt: Date.now(), operatorAttested: true, independentlyVerifiedByFixture: false };
      event.executionReceipt = receipt; event.status = "operator_receipt_recorded";
      event.inferenceExecuted = true; event.deliveryExecuted = true;
      const job = state.jobs.find((entry) => entry.id === event.jobId);
      job.executionReceipts.push(receipt); job.inferenceExecuted = true; job.deliveryExecuted = true;
      state.inferenceExecuted = true; state.deliveryExecuted = true;
      return send(200, { event, receipt, inferenceRunner: false, warning: "Operator attestation only; verify external inference and backend artifacts. This fixture executed neither." });
    }
    if (url.pathname !== "/mcp") return send(404, { error: "Not found" });
    if (request.method === "DELETE") return send(204, null);
    if (request.method !== "POST") return send(405, { error: "Use POST JSON-RPC" });
    const payload = await read(request);
    if (payload.jsonrpc !== "2.0" || typeof payload.method !== "string") return send(200, { jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32600, message: "Invalid request" } });
    if (payload.id === undefined) return send(202, null);
    const result = (value) => send(200, { jsonrpc: "2.0", id: payload.id, result: value });
    if (payload.method === "initialize") return result({ protocolVersion: ["2025-11-25", "2025-06-18", "2025-03-26"].includes(payload.params?.protocolVersion) ? payload.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Fictional workshop news and clock", version: "1.0.0" }, instructions: "Synthetic corpus with isolated simulated daily due jobs. Register jobs with news_schedule_create; only America/Los_Angeles is supported. The operator advances the clock and dispatches external actual model inference using your saved instructions when due. Do not generate or deliver the digest during registration. This fixture never executes inference or delivery; due events and operator receipts alone are not independent evidence of execution." });
    if (payload.method === "ping") return result({});
    if (payload.method === "tools/list") return result({ tools: TOOLS });
    if (payload.method === "tools/call") {
      const at = Date.now(); const name = payload.params?.name; const input = payload.params?.arguments || {};
      try {
        const providerText = JSON.stringify(call(name, input));
        auditCall(at, name, input, JSON.parse(providerText), "completed");
        return result({ content: [{ type: "text", text: providerText }], isError: false });
      } catch (error) {
        auditCall(at, name, input, error.message, "error");
        return result({ content: [{ type: "text", text: error.message }], isError: true });
      }
    }
    return send(200, { jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: "Method not found" } });
  } catch (error) { send(400, { error: error.message }); }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(PORT, HOST, () => console.log(`Fictional workshop news listening at http://${HOST}:${server.address().port}; isolated daily due jobs, no inference runner or delivery`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.close(); server.closeAllConnections(); });
