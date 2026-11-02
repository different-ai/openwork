import { randomUUID } from "node:crypto"
import type { McpServer } from "@modelcontextprotocol/server"
import type { McpAppToolBinding, McpAppToolDeclaration, PrepareMcpAppInput, PrepareMcpAppOutput } from "@openwork/types/mcp-app"
import { generatedAppLibrariesNextStep } from "../generated-app-libraries.js"
import { runsWithoutClick } from "./app-tool-access.js"

/**
 * OpenWork's opinionated App starters. prepare_app returns the one that fits
 * the verified tools, already calling them with inputs built from their
 * schemas; the same three are readable as resources. Each covers the host
 * rules (theme, reads that load on open, one click per change, approval,
 * blocked) and every state, so
 * the author only replaces the presentation.
 */
export type AppStarterPattern = "lookup" | "action" | "standalone"

export const APP_STARTER_RESOURCE_ROOT = "openwork://apps/starters"
export const appStarterResourceUri = (pattern: AppStarterPattern) => `${APP_STARTER_RESOURCE_ROOT}/${pattern}.json`

/**
 * A preparation never runs a tool or saves an App. It lists the built-in
 * libraries that may be imported in an MCP App.
 */
export function appAuthoringStarter(input: PrepareMcpAppInput, tools: McpAppToolBinding[]): PrepareMcpAppOutput {
  const starter = appStarter(tools)
  return {
    preparationId: randomUUID(),
    title: input.title,
    tools,
    starter: { reactSource: starter.reactSource, cssSource: starter.cssSource },
    nextSteps: [...starter.nextSteps, generatedAppLibrariesNextStep()],
  }
}

type FieldKind = "text" | "number" | "integer" | "checkbox" | "select"
type Primitive = string | number | boolean
type StarterField = {
  name: string
  label: string
  kind: FieldKind
  required: boolean
  placement?: "path" | "query"
  options?: Primitive[]
  defaultValue?: Primitive
}
type StarterTool = { name: string; label: string; fields: StarterField[]; live: boolean }

const MAX_FIELDS = 6
const MAX_OPTIONS = 20

/** The pattern a set of verified tools calls for. */
export function appStarterPattern(tools: McpAppToolBinding[]): AppStarterPattern {
  if (tools.length === 0) return "standalone"
  return tools.some((tool) => !runsWithoutClick(tool)) ? "action" : "lookup"
}

export function appStarter(tools: McpAppToolBinding[]) {
  const pattern = appStarterPattern(tools)
  if (pattern === "standalone") {
    return {
      pattern,
      reactSource: [STARTER_HEADER, SHARED_SOURCE, STANDALONE_SOURCE].join("\n"),
      cssSource: STARTER_CSS,
      nextSteps: [
        "Starter: standalone. It has no tools: compute() turns the inputs in FIELDS (prefilled from the launch input) into the figures it shows, the first one largest.",
        "Replace FIELDS and compute() with this App's inputs and logic, and the empty notice with what to enter first. Keep useTheme and the shared components.",
        "Then call create_app with this preparationId.",
      ],
    }
  }
  const change = pattern === "action" ? tools.find((tool) => !runsWithoutClick(tool)) : undefined
  const load = change
    ? tools.find((tool) => runsWithoutClick(tool) && !starterTool(tool).fields.some((field) => field.required))
    : tools[0]
  const wired = [change, load].flatMap((tool) => tool ? [tool.name] : [])
  const unwired = tools.filter((tool) => !wired.includes(tool.name)).map((tool) => tool.name)
  const constants = [
    change ? `const CHANGE = ${toolLiteral(starterTool(change))};` : "",
    `const LOAD = ${load ? toolLiteral(starterTool(load)) : "null"};`,
  ].filter(Boolean).join("\n")
  const body = change ? ACTION_SOURCE : LOOKUP_SOURCE
  const describe = change
    ? `Starter: action. ${change.name} runs once per click of its button, from inputs built from its schema${load ? `; ${load.name} loads when the App opens and again from its own button` : ""}. It covers approval, failure, and blocked states.`
    : `Starter: lookup. ${load?.name} loads when the App opens, with inputs built from its schema and filled from the launch input: the last result for them shows at once while it refreshes, and Enter or its button loads it again. It covers loading, empty, stale, approval, failure, and blocked states.`
  return {
    pattern,
    reactSource: [STARTER_HEADER, constants, SHARED_SOURCE, body].join("\n"),
    cssSource: STARTER_CSS,
    nextSteps: [
      describe,
      change
        ? "Rename the button and its done line to exactly what happens (for example \"Create invoice\" and \"Invoice created\"), keep only the inputs the person needs, and show the outcome they care about."
        : "Rename the button to the outcome (for example \"Find orders\"), keep only the inputs the person needs, and replace ResultView with the focal view they came for: the list, number, or status. Keep its load on open.",
      ...(unwired.length > 0 ? [`Also declared but not wired yet: ${unwired.join(", ")}. Give each its own control.`] : []),
      "Keep useTheme, useToolCall, and the state components, then call create_app with this preparationId.",
    ],
  }
}

function starterTool(tool: McpAppToolBinding): StarterTool {
  const live = tool.kind === "workflow" && tool.mode === "live"
  const schema = tool.inputSchema
  const fields = live
    ? []
    : tool.kind === "api"
      ? [...schemaFields(record(record(schema.properties).path), "path"), ...schemaFields(record(record(schema.properties).query), "query")]
      : schemaFields(schema)
  return {
    name: tool.name,
    label: actionLabel(tool),
    fields: [...fields.filter((field) => field.required), ...fields.filter((field) => !field.required)].slice(0, MAX_FIELDS),
    live,
  }
}

/** Labeled inputs for an object schema's simple top-level properties. */
function schemaFields(schema: Record<string, unknown>, placement?: "path" | "query"): StarterField[] {
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string") : []
  return Object.entries(record(schema.properties)).flatMap(([name, value]): StarterField[] => {
    const property = record(value)
    if (!/^[A-Za-z_$][\w$.-]{0,63}$/u.test(name)) return []
    const label = typeof property.title === "string" && /^[\p{L}\p{N} ,.'()%/-]{1,40}$/u.test(property.title.trim())
      ? property.title.trim()
      : humanize(name)
    const base = { name, label, required: required.includes(name), ...(placement ? { placement } : {}) }
    const defaultValue = isPrimitive(property.default) ? { defaultValue: property.default } : {}
    if (Array.isArray(property.enum)) {
      const options = property.enum.filter(isPrimitive).slice(0, MAX_OPTIONS)
      return options.length > 0 ? [{ ...base, kind: "select", options, ...defaultValue }] : []
    }
    const type = Array.isArray(property.type) ? property.type.find((entry) => entry !== "null") : property.type
    if (type === "string") return [{ ...base, kind: "text", ...defaultValue }]
    if (type === "number") return [{ ...base, kind: "number", ...defaultValue }]
    if (type === "integer") return [{ ...base, kind: "integer", ...defaultValue }]
    if (type === "boolean") return [{ ...base, kind: "checkbox", ...defaultValue }]
    return []
  })
}

/** "create_invoice" → "Create invoice"; a read with no verb gets "Find" or "Refresh". */
function actionLabel(tool: McpAppToolBinding): string {
  const label = humanize(tool.name)
  if (!runsWithoutClick(tool)) return label
  if (/^(?:find|search|get|list|look|load|show|read|check|fetch|query|lookup)\b/iu.test(label)) {
    return label.replace(/^(?:get|list|load|fetch|query|read|lookup)\b/iu, "Show")
  }
  return Object.keys(record(tool.inputSchema.properties)).length > 0 ? "Find" : "Refresh"
}

function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_\-.$]+/gu, " ").trim().toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : name
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isPrimitive(value: unknown): value is Primitive {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
}

function toolLiteral(tool: StarterTool): string {
  const fields = tool.fields.map((field) => `    { ${[
    `name: ${jsString(field.name)}`,
    `label: ${jsString(field.label)}`,
    `kind: ${jsString(field.kind)}`,
    `required: ${field.required}`,
    ...(field.placement ? [`placement: ${jsString(field.placement)}`] : []),
    ...(field.options ? [`options: [${field.options.map(jsPrimitive).join(", ")}]`] : []),
    ...(field.defaultValue !== undefined ? [`defaultValue: ${jsPrimitive(field.defaultValue)}`] : []),
  ].join(", ")} },`)
  return [
    "{",
    `  name: ${jsString(tool.name)},`,
    `  label: ${jsString(tool.label)},`,
    `  live: ${tool.live},`,
    fields.length > 0 ? ["  fields: [", ...fields, "  ],"].join("\n") : "  fields: [],",
    "}",
  ].join("\n")
}

function jsPrimitive(value: Primitive): string {
  return typeof value === "string" ? jsString(value) : String(value)
}

// The App compiler reads source text before parsing it, so schema text such as
// an "import" key or a "<" in a title must never form what it refuses. Risky
// words are split across a join, which no compiler step folds back together.
const RISKY_TEXT = /import|require|export|eval|Function|setTimeout|setInterval|dangerouslySetInnerHTML|__openworkSafeReact|@jsx/gu

function jsString(text: string): string {
  const pieces: string[] = []
  let start = 0
  for (const match of text.matchAll(RISKY_TEXT)) {
    const split = (match.index ?? 0) + 1
    pieces.push(text.slice(start, split))
    start = split
  }
  pieces.push(text.slice(start))
  const literals = pieces.map((piece) => JSON.stringify(piece).replace(/[<>]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`))
  return literals.length === 1 ? literals[0]! : `[${literals.join(", ")}].join("")`
}

const STARTER_HEADER = `// OpenWork App starter. Keep useTheme, useToolCall and the state components:
// they follow the host's rules. Make the App component the view the person asked for.`

const SHARED_SOURCE = `
const MAX_ROWS = 8;
const MAX_COLUMNS = 4;
const numberFormat = new Intl.NumberFormat();

// The host sends its colors and fonts, and sends them again when the person
// switches light or dark; applying them at the root keeps the App in step.
function useTheme(hostContext) {
  const variables = hostContext?.styles?.variables;
  const scheme = hostContext?.theme ?? "light dark";
  return React.useMemo(() => ({ ...(variables ?? {}), colorScheme: scheme }), [variables, scheme]);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function textOf(response) {
  return (response?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text).join("\\n").trim();
}

function valueOf(response) {
  if (response?.structuredContent !== undefined) return response.structuredContent;
  const text = textOf(response);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageOf(response) {
  const text = textOf(response);
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.message ?? parsed?.error?.message ?? parsed?.error;
    if (typeof message === "string" && message) return message;
  } catch {}
  return text || "That didn't work. Try again.";
}

function dateOf(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date : null;
}

// OpenWork's App server runs read-only tools that need no input as the App
// opens and sends what they returned with the launch, under
// "openwork/initialResults". One made with exactly these arguments is shown
// instead of calling again; anything else is called as usual.
function initialResultFor(result, name, args) {
  const entries = result?._meta?.["openwork/initialResults"];
  if (!Array.isArray(entries)) return null;
  const asked = JSON.stringify(args);
  return entries.find((entry) => entry?.name === name && JSON.stringify(entry.arguments ?? {}) === asked) ?? null;
}

// Shows the launch's result for these arguments, or calls the tool for one.
// A checked matching snapshot seeds the view too. Older launch producers can
// supply an earlier load time, in which case refresh behind the visible data.
function loadWith(call, result, name, args) {
  const loaded = initialResultFor(result, name, args);
  if (!loaded) return call.call(args);
  call.seed(args, loaded);
  const loadedAt = dateOf(loaded.loadedAt);
  if (loaded.kept && (!loadedAt || Date.now() - loadedAt.getTime() > 60000)) call.call(args);
}

// One declared tool, with every state the person can see. Only the latest
// call updates the view, so a slow earlier answer never replaces a newer one.
// OpenWork keeps read-only results, so peek shows the last one at once
// without running the tool while a call refreshes it. A failed refresh keeps
// the value on screen with its time, so the person knows it is stale.
function useToolCall(app, name) {
  const [state, setState] = React.useState({ status: "idle" });
  const latest = React.useRef(0);
  const latestPeek = React.useRef(0);
  // The inputs of the newest peek or call; a kept result for other inputs is never shown.
  const latestArgs = React.useRef(null);
  const available = Boolean(name) && Boolean(app?.getHostCapabilities()?.serverTools);
  // Only OpenWork answers a cached read from storage; elsewhere it would run the tool.
  const cacheable = app?.getHostContext()?.experimental?.["openwork/result-cache"] === true;
  const peek = React.useCallback(async (args) => {
    if (!available || !cacheable) return;
    const asked = JSON.stringify(args);
    latestArgs.current = asked;
    // A slower earlier peek never overwrites a newer one, and a finished call wins over both.
    const peekId = ++latestPeek.current;
    let response;
    try {
      response = await app.callServerTool({ name, arguments: args, _meta: { "openwork/cache": "read" } });
    } catch {
      return;
    }
    if (peekId !== latestPeek.current || latestArgs.current !== asked) return;
    const meta = response?._meta;
    // A kept result replaces nothing newer; with none kept, an earlier kept
    // result for other inputs is cleared rather than shown under these.
    if (response?.isError || meta?.["openwork/cached"] !== true) {
      setState((previous) => previous.cached ? { status: previous.status === "loading" ? "loading" : "idle" } : previous);
      return;
    }
    // A call still running keeps loading behind the kept value.
    setState((previous) => previous.value === undefined || previous.cached
      ? { status: previous.status === "loading" ? "loading" : "ready", value: valueOf(response), updatedAt: dateOf(meta["openwork/cachedAt"]) ?? new Date(), cached: true }
      : previous);
  }, [app, name, available, cacheable]);
  const call = React.useCallback(async (args) => {
    if (!available) return false;
    latestArgs.current = JSON.stringify(args);
    const id = ++latest.current;
    setState((previous) => ({ ...previous, status: "loading" }));
    let response;
    try {
      response = await app.callServerTool({ name, arguments: args, _meta: { "openwork/cache": "store" } });
    } catch (reason) {
      response = { isError: true, content: [{ type: "text", text: reason instanceof Error ? reason.message : String(reason) }] };
    }
    if (id !== latest.current) return false;
    if (response?.isError) {
      const message = messageOf(response);
      setState((previous) => ({ ...previous, status: /approv/i.test(message) ? "approval" : "error", message }));
      return false;
    }
    // An answer OpenWork already loaded for this open carries the time it loaded.
    setState({ status: "ready", value: valueOf(response), updatedAt: dateOf(response?._meta?.["openwork/cachedAt"]) ?? new Date() });
    return true;
  }, [app, name, available]);
  // A result that came with the launch answers like a call that just
  // finished, and wins over any earlier peek or call still running.
  const seed = React.useCallback((args, loaded) => {
    latestArgs.current = JSON.stringify(args);
    ++latest.current;
    ++latestPeek.current;
    setState({ status: "ready", value: valueOf(loaded.result), updatedAt: dateOf(loaded.loadedAt) ?? new Date() });
  }, []);
  return { ...state, available, call, peek, seed };
}

function humanize(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\\-.$]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : String(key);
}

// "in_progress" reads "In progress"; codes such as "USD" stay as they are.
function optionLabel(option) {
  return typeof option === "string" && /^[a-z][a-z0-9_-]*$/.test(option) ? humanize(option) : String(option);
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return numberFormat.format(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && /^\\d{4}-\\d{2}-\\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  if (Array.isArray(value)) return value.length === 1 ? "1 item" : value.length + " items";
  if (isRecord(value)) return String(value.name ?? value.title ?? value.label ?? "…");
  return String(value);
}

function timeOf(date) {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// The list a result holds: the result itself, or its first list field (items, results, rows…).
function rowsOf(value) {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(value).find(Array.isArray) ?? null;
  return null;
}

// Up to four readable columns; ids stay out of sight.
function columnsOf(rows) {
  const keys = [];
  for (const row of rows) {
    for (const [key, entry] of Object.entries(row)) {
      if (!keys.includes(key) && isScalar(entry) && !/^(?:id|uuid)$|(?:Id|_id)$/.test(key)) keys.push(key);
    }
  }
  return keys.slice(0, MAX_COLUMNS);
}

function initialValues(fields, launchInput) {
  const values = {};
  for (const field of fields) {
    const source = field.placement ? launchInput?.[field.placement] : launchInput;
    const launched = isRecord(source) ? source[field.name] : undefined;
    // A required choice starts on its first option, as the select shows it.
    const value = launched ?? field.defaultValue ?? (field.kind === "select" && field.required ? field.options[0] : undefined);
    values[field.name] = field.kind === "checkbox" ? value === true : value === undefined || value === null ? "" : String(value);
  }
  return values;
}

function isFilled(field, value) {
  return field.kind === "checkbox" || (value !== undefined && String(value).trim() !== "");
}

function isReady(fields, values) {
  return fields.every((field) => !field.required || isFilled(field, values[field.name]));
}

function argumentValue(field, value) {
  if (field.kind === "checkbox") return value === true;
  if (!isFilled(field, value)) return undefined;
  if (field.kind === "number" || field.kind === "integer") {
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    return field.kind === "integer" ? Math.trunc(number) : number;
  }
  if (field.kind === "select") return (field.options ?? []).find((option) => String(option) === String(value)) ?? value;
  return String(value).trim();
}

// Arguments in the shape the tool's verified schema asks for.
function argumentsFor(tool, values) {
  const args = {};
  for (const field of tool.fields) {
    const value = argumentValue(field, values[field.name]);
    if (value === undefined) continue;
    if (field.placement) args[field.placement] = { ...(args[field.placement] ?? {}), [field.name]: value };
    else args[field.name] = value;
  }
  if (tool.live) args.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return args;
}

function Field({ field, value, onChange, onEnter }) {
  if (field.kind === "checkbox") {
    return (
      <label className="field check">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }
  return (
    <label className="field">
      <span>{field.label}</span>
      {field.kind === "select" ? (
        <select value={value} required={field.required} onChange={(event) => onChange(event.target.value)}>
          {field.required ? null : <option value="">Any</option>}
          {field.options.map((option) => <option key={String(option)} value={String(option)}>{optionLabel(option)}</option>)}
        </select>
      ) : (
        <input
          type={field.kind === "text" ? "text" : "number"}
          step={field.kind === "integer" ? 1 : "any"}
          value={value}
          required={field.required}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && onEnter) onEnter(); }}
        />
      )}
    </label>
  );
}

function Fields({ fields, values, onChange, onEnter }) {
  return fields.map((field) => (
    <Field
      key={field.name}
      field={field}
      value={values[field.name]}
      onChange={(value) => onChange((previous) => ({ ...previous, [field.name]: value }))}
      onEnter={onEnter}
    />
  ));
}

// Blocked, approval and failure states, each with its next step.
function ToolNotice({ call, retryLabel, onRetry, showBlocked = true }) {
  if (!call.available) return showBlocked ? <p className="notice">Open this App in OpenWork to use its live data.</p> : null;
  if (call.status === "approval") {
    return <p className="notice">This needs your approval first. <button type="button" onClick={onRetry}>{retryLabel}</button></p>;
  }
  if (call.status === "error") {
    const stale = call.value !== undefined && call.updatedAt ? " Showing what loaded at " + timeOf(call.updatedAt) + "." : "";
    return <p className="notice" role="alert" data-tone="danger">{call.message}{stale} <button type="button" onClick={onRetry}>Try again</button></p>;
  }
  return null;
}

// Placeholder rows shaped like the result, instead of "Loading…".
function Skeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      {[0, 1, 2].map((row) => <div key={row} className="skeleton-row" />)}
    </div>
  );
}

// A general view of any result: a table for a list of records, a list, or facts.
// Replace it with the view this App is for.
function ResultView({ value, emptyText }) {
  const rows = rowsOf(value);
  if (rows) {
    if (rows.length === 0) return <p className="notice">{emptyText}</p>;
    const shown = rows.slice(0, MAX_ROWS);
    const columns = shown.every(isRecord) ? columnsOf(shown) : [];
    return (
      <div className="result">
        {columns.length > 0 ? (
          <table>
            <thead>
              <tr>{columns.map((column) => <th key={column} scope="col">{humanize(column)}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((row, index) => (
                <tr key={index}>{columns.map((column) => <td key={column} title={formatValue(row[column])}>{formatValue(row[column])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ul className="list">{shown.map((row, index) => <li key={index}>{formatValue(row)}</li>)}</ul>
        )}
        {rows.length > shown.length ? <p className="meta">Showing {shown.length} of {rows.length}</p> : null}
      </div>
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, entry]) => isScalar(entry)).slice(0, MAX_ROWS);
    if (entries.length === 0) return <p className="notice">{emptyText}</p>;
    return (
      <dl className="facts">
        {entries.map(([key, entry]) => <div key={key}><dt>{humanize(key)}</dt><dd>{formatValue(entry)}</dd></div>)}
      </dl>
    );
  }
  if (value === null || value === undefined || value === "") return <p className="notice">{emptyText}</p>;
  return <p className="focal">{formatValue(value)}</p>;
}
`

const LOOKUP_SOURCE = `
export default function App({ app, input, result, hostContext }) {
  const theme = useTheme(hostContext);
  const load = useToolCall(app, LOAD.name);
  const [values, setValues] = React.useState(() => initialValues(LOAD.fields, input));
  const launch = JSON.stringify(input ?? {});
  // Opening the App is enough to load its data: once the host has delivered
  // the launch, the launch input fills the inputs and, when they are ready,
  // the read loads with no click. OpenWork runs it once per open.
  const delivered = result !== undefined;
  React.useEffect(() => {
    const next = initialValues(LOAD.fields, input);
    setValues(next);
    if (delivered && isReady(LOAD.fields, next)) loadWith(load, result, LOAD.name, argumentsFor(LOAD, next));
  }, [launch, delivered]);
  // A later launch result is the host refreshing the open App, as a dashboard
  // does: load the same inputs again while the data stays on screen.
  const refreshed = React.useRef(result);
  React.useEffect(() => {
    const previous = refreshed.current;
    refreshed.current = result;
    if (previous !== undefined && previous !== result && isReady(LOAD.fields, values)) loadWith(load, result, LOAD.name, argumentsFor(LOAD, values));
  }, [result]);
  // The last result for these inputs shows at once, from OpenWork's storage.
  const query = JSON.stringify(values);
  React.useEffect(() => {
    if (isReady(LOAD.fields, values)) load.peek(argumentsFor(LOAD, values));
  }, [query]);
  const ready = isReady(LOAD.fields, values);
  const find = () => {
    if (ready) load.call(argumentsFor(LOAD, values));
  };
  const needed = LOAD.fields.filter((field) => field.required && !isFilled(field, values[field.name])).map((field) => field.label);
  const rows = rowsOf(load.value);
  return (
    <main className="app" style={theme}>
      <div className="controls">
        <Fields fields={LOAD.fields} values={values} onChange={setValues} onEnter={find} />
        <button type="button" className="primary" onClick={find} disabled={!ready || !load.available || load.status === "loading"}>{LOAD.label}</button>
      </div>
      <ToolNotice call={load} retryLabel={LOAD.label} onRetry={find} />
      <section className="result" aria-live="polite" aria-busy={load.status === "loading"}>
        {load.value === undefined
          ? load.status === "loading" ? <Skeleton /> : needed.length > 0 && load.available ? <p className="notice">Enter {needed.join(" and ")} to see results.</p> : null
          : <ResultView value={load.value} emptyText={LOAD.fields.length > 0 ? "Nothing matches. Try different inputs." : "Nothing here yet."} />}
      </section>
      {load.updatedAt ? (
        <p className="meta">
          {rows ? (rows.length === 1 ? "1 result · " : rows.length + " results · ") : ""}Updated {timeOf(load.updatedAt)}{load.status === "loading" ? " · Refreshing…" : ""}
        </p>
      ) : null}
    </main>
  );
}
`

const ACTION_SOURCE = `
export default function App({ app, input, result, hostContext }) {
  const theme = useTheme(hostContext);
  const change = useToolCall(app, CHANGE.name);
  const load = useToolCall(app, LOAD ? LOAD.name : "");
  const [values, setValues] = React.useState(() => initialValues(CHANGE.fields, input));
  const launch = JSON.stringify(input ?? {});
  // The launch input only fills the inputs; each tool runs from its own button.
  React.useEffect(() => {
    setValues(initialValues(CHANGE.fields, input));
  }, [launch]);
  // The read loads when the App opens, showing its last result at once while
  // it refreshes, and again from its button. Only the change waits for a click.
  const delivered = result !== undefined;
  React.useEffect(() => {
    if (LOAD) load.peek(argumentsFor(LOAD, {}));
  }, []);
  React.useEffect(() => {
    if (LOAD && delivered) loadWith(load, result, LOAD.name, argumentsFor(LOAD, {}));
  }, [delivered]);
  // A later launch result is the host refreshing the open App, as a dashboard
  // does: load again while the data stays on screen.
  const refreshed = React.useRef(result);
  React.useEffect(() => {
    const previous = refreshed.current;
    refreshed.current = result;
    if (LOAD && previous !== undefined && previous !== result) loadWith(load, result, LOAD.name, argumentsFor(LOAD, {}));
  }, [result]);
  const reload = () => {
    if (LOAD) load.call(argumentsFor(LOAD, {}));
  };
  // One click makes one call; the host may ask the person to approve it first.
  const submit = async () => {
    if (!isReady(CHANGE.fields, values) || change.status === "loading") return;
    if (await change.call(argumentsFor(CHANGE, values))) setValues(initialValues(CHANGE.fields, {}));
  };
  return (
    <main className="app" style={theme}>
      <div className="controls">
        <Fields fields={CHANGE.fields} values={values} onChange={setValues} />
        <button
          type="button"
          className="primary"
          onClick={submit}
          aria-busy={change.status === "loading"}
          disabled={!isReady(CHANGE.fields, values) || !change.available || change.status === "loading"}
        >
          {CHANGE.label}
        </button>
      </div>
      <ToolNotice call={change} retryLabel={CHANGE.label} onRetry={submit} />
      {change.status === "ready" ? (
        <div className="outcome" role="status">
          <p className="meta">Done at {timeOf(change.updatedAt)}</p>
          {LOAD ? null : <ResultView value={change.value} emptyText="Done." />}
        </div>
      ) : null}
      {LOAD ? (
        <section className="result" aria-live="polite" aria-busy={load.status === "loading"}>
          <ToolNotice call={load} retryLabel={LOAD.label} onRetry={reload} showBlocked={false} />
          {load.value === undefined
            ? load.status === "loading" ? <Skeleton /> : null
            : <ResultView value={load.value} emptyText="Nothing here yet." />}
          <p className="meta">
            <button type="button" className="link" onClick={reload} disabled={!load.available || load.status === "loading"}>{LOAD.label}</button>
            {load.updatedAt ? " · Updated " + timeOf(load.updatedAt) : ""}{load.status === "loading" && load.value !== undefined ? " · Refreshing…" : ""}
          </p>
        </section>
      ) : null}
    </main>
  );
}
`

const STANDALONE_SOURCE = `
const FIELDS = [
  { name: "amount", label: "Amount", kind: "number", required: true },
  { name: "share", label: "Share (%)", kind: "number", required: true, defaultValue: 20 },
];

// This App's logic: the figures to show, most important first.
function compute(values) {
  const amount = Number(values.amount);
  const share = Number(values.share);
  if (!Number.isFinite(amount) || !Number.isFinite(share)) return null;
  const part = (amount * share) / 100;
  return [
    { label: "Share", value: part },
    { label: "Remainder", value: amount - part },
  ];
}

export default function App({ input, hostContext }) {
  const theme = useTheme(hostContext);
  const [values, setValues] = React.useState(() => initialValues(FIELDS, input));
  const launch = JSON.stringify(input ?? {});
  React.useEffect(() => {
    setValues(initialValues(FIELDS, input));
  }, [launch]);
  const figures = React.useMemo(() => (isReady(FIELDS, values) ? compute(values) : null), [values]);
  return (
    <main className="app" style={theme}>
      <div className="controls">
        <Fields fields={FIELDS} values={values} onChange={setValues} />
      </div>
      {figures && figures.length > 0 ? (
        <div className="outcome" aria-live="polite">
          <p className="focal">{formatValue(figures[0].value)}</p>
          <p className="meta">{figures[0].label}</p>
          {figures.length > 1 ? (
            <dl className="facts">
              {figures.slice(1).map((figure) => <div key={figure.label}><dt>{figure.label}</dt><dd>{formatValue(figure.value)}</dd></div>)}
            </dl>
          ) : null}
        </div>
      ) : (
        <p className="notice">Enter an amount to see the result.</p>
      )}
    </main>
  );
}
`

const STARTER_CSS = `:root { color-scheme: light dark; }
body { margin: 0; }
.app { box-sizing: border-box; container-type: inline-size; display: grid; gap: 12px; min-width: 0; padding: 12px 14px; color: var(--color-text-primary, CanvasText); background: var(--color-background-primary, Canvas); font: 13px/1.5 var(--font-sans, system-ui, sans-serif); }
.app *, .app *::before, .app *::after { box-sizing: border-box; }
.controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.field { display: grid; flex: 1 1 140px; gap: 4px; min-width: 0; }
.field > span, .meta, th, dt { color: var(--color-text-secondary, GrayText); font-size: 12px; }
.check { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; min-height: 32px; }
input, select, button { min-height: 32px; border-radius: 6px; font: inherit; color: inherit; }
input, select { width: 100%; padding: 5px 8px; border: 1px solid var(--color-border-primary, rgba(128, 128, 128, 0.35)); background: var(--color-background-primary, Canvas); }
.check input { width: auto; min-height: 0; }
button { padding: 5px 12px; border: 1px solid var(--color-border-primary, rgba(128, 128, 128, 0.35)); background: var(--color-background-secondary, transparent); cursor: pointer; white-space: nowrap; }
button.primary { border-color: transparent; background: var(--color-background-inverse, CanvasText); color: var(--color-text-inverse, Canvas); font-weight: 500; }
button.link { min-height: 0; padding: 0; border: 0; background: none; text-decoration: underline; }
button:disabled { cursor: default; opacity: 0.5; }
:focus-visible { outline: 2px solid var(--color-border-info, Highlight); outline-offset: 1px; }
.notice { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--color-background-secondary, rgba(128, 128, 128, 0.08)); }
.notice[data-tone="danger"] { color: var(--color-text-danger, CanvasText); background: var(--color-background-danger, rgba(128, 128, 128, 0.08)); }
.notice button { margin-left: 6px; }
.meta { margin: 0; }
.focal { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.result, .outcome { display: grid; gap: 6px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-variant-numeric: tabular-nums; }
th { padding: 0 8px 4px 0; font-weight: 500; text-align: left; }
td { padding: 6px 8px 6px 0; border-top: 1px solid var(--color-border-primary, rgba(128, 128, 128, 0.2)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list { display: grid; gap: 4px; margin: 0; padding-left: 18px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
.facts div { display: contents; }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.skeleton { display: grid; gap: 8px; }
.skeleton-row { height: 14px; border-radius: 4px; background: var(--color-background-tertiary, rgba(128, 128, 128, 0.15)); }
@media (prefers-reduced-motion: no-preference) { button { transition: opacity 150ms ease-out, background-color 150ms ease-out; } }
@container (max-width: 380px) {
  .controls { flex-direction: column; align-items: stretch; }
  .field { flex-basis: auto; }
  .controls button.primary { width: 100%; }
  .facts { grid-template-columns: 1fr; gap: 0; }
  .facts dd { margin-bottom: 6px; }
}`

const SAMPLE_CAPABILITY = "<exact capability from search_capabilities>"

type StarterSample = {
  pattern: AppStarterPattern
  title: string
  useWhen: string
  tools: McpAppToolBinding[]
  textFallback: string
}

const STARTER_SAMPLES: StarterSample[] = [
  {
    pattern: "lookup",
    title: "Lookup App starter",
    useWhen: "Every bound tool only reads: a dashboard, list, status board, or search. Loads its data when it opens.",
    tools: [{
      name: "find_orders",
      description: "Find orders by status and customer.",
      capability: SAMPLE_CAPABILITY,
      kind: "mcp",
      mode: "input",
      readOnly: true,
      inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "shipped", "delivered"] }, customer: { type: "string", title: "Customer" } } },
    }],
    textFallback: "Finds orders by status and customer, newest first.",
  },
  {
    pattern: "action",
    title: "Action App starter",
    useWhen: "At least one bound tool changes data: a form that creates, updates, or sends something, with a read that shows the result.",
    tools: [
      {
        name: "create_task",
        description: "Create a task with a title and an optional due date.",
        capability: SAMPLE_CAPABILITY,
        kind: "workflow",
        mode: "input",
        readOnly: false,
        inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string", title: "Title" }, due: { type: "string", title: "Due date" } } },
      },
      {
        name: "list_tasks",
        description: "List open tasks.",
        capability: SAMPLE_CAPABILITY,
        kind: "mcp",
        mode: "input",
        readOnly: true,
        inputSchema: { type: "object", properties: {} },
      },
    ],
    textFallback: "Creates a task and lists the open ones.",
  },
  {
    pattern: "standalone",
    title: "Standalone App starter",
    useWhen: "No tools: calculators, converters, checklists, and planners that work from their inputs and the launch input alone.",
    tools: [],
    textFallback: "Splits an amount by a percentage and shows both parts.",
  },
]

function sampleDeclaration(tool: McpAppToolBinding): McpAppToolDeclaration {
  return { name: tool.name, description: tool.description, capability: tool.capability, ...(tool.mode === "live" ? { mode: "live" as const } : {}) }
}

/** The three starters as read-only resources any MCP client can read before building. */
export function registerAppStarterResources(server: McpServer) {
  for (const sample of STARTER_SAMPLES) {
    const uri = appStarterResourceUri(sample.pattern)
    server.registerResource(`app-starter-${sample.pattern}`, uri, {
      title: sample.title,
      description: sample.useWhen,
      mimeType: "application/json",
    }, async () => {
      const starter = appStarter(sample.tools)
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            pattern: sample.pattern,
            useWhen: sample.useWhen,
            tools: sample.tools.map(sampleDeclaration),
            reactSource: starter.reactSource,
            cssSource: starter.cssSource,
            textFallback: sample.textFallback,
            note: "prepare_app returns this starter already wired to your verified tools; this copy uses sample tools.",
          }),
        }],
      }
    })
  }
}
