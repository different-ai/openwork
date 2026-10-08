import { randomUUID } from "node:crypto"
import type { McpAppToolBinding, PrepareMcpAppInput, PrepareMcpAppOutput } from "@openwork/types/mcp-app"

/** A safe starting point, with verified tool schemas; preparation never runs a tool or saves an App. */
export function appAuthoringStarter(input: PrepareMcpAppInput, tools: McpAppToolBinding[]): PrepareMcpAppOutput {
  const tool = tools[0]
  return {
    preparationId: randomUUID(),
    title: input.title,
    tools,
    starter: {
      reactSource: `export default function App({ app, input }) {
  const [state, setState] = React.useState("idle");
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState("");
  const available = Boolean(app.getHostCapabilities()?.serverTools);
  async function run() {
    setState("loading"); setError("");
    try {
      // Replace arguments and the result display using the verified tool schema.
      const response = await app.callServerTool({ name: ${JSON.stringify(tool?.name ?? "replace_with_declared_tool")}, arguments: {} });
      if (response.isError) throw new Error(response.content?.find(item => item.type === "text")?.text || "The request failed. Try again.");
      setData(response.structuredContent ?? null); setState("ready");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request failed. Try again."); setState("error");
    }
  }
  return <main>
    <h1>${escapeJsx(input.title)}</h1>
    <p>${escapeJsx(input.description || "Choose your inputs to get started.")}</p>
    ${tool ? `<button type="button" disabled={!available || state === "loading"} onClick={run}>{state === "loading" ? "Working…" : "${tool.readOnly ? "Refresh" : "Continue"}"}</button>
    {!available && <p role="status">Open this app in a host that supports its tools.</p>}` : ""}
    {error && <p role="alert">{error}</p>}
    {state === "ready" && <p role="status">{data ? "Loaded. Replace this with the app’s result view." : "No results yet. Try different inputs."}</p>}
  </main>;
}`,
      cssSource: "main { padding: 20px; font: 14px/1.5 system-ui; color: var(--color-text-primary); } h1 { font-size: 18px; margin: 0 0 8px; } button { padding: 8px 12px; } [role=alert] { color: var(--color-text-danger); }",
    },
    nextSteps: [
      "Adapt the starter to the requested outcome: one focal action, labeled inputs, a useful result view, and loading, empty, error, and blocked states.",
      "Use the verified tools and input schemas below. Fill in valid arguments and handle their actual results; remove placeholder text. Read-only calls may load automatically; every other call needs its own button and one call per click.",
      "Call create_app directly with preparationId, complete React/CSS, the original tool declarations, and a readable textFallback. It rechecks access, compiles the source, and saves the App. Preparation is not proof that creation passed.",
      "If creation fails, fix the reported error and retry. On success OpenWork opens the App in a right-sidebar tab. Keep the final reply brief.",
    ],
  }
}

function escapeJsx(text: string): string {
  return `{${JSON.stringify(text).replaceAll("<", "\\u003c")}}`
}
