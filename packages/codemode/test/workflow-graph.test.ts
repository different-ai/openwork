import { describe, expect, test } from "bun:test"
import { WorkflowGraph } from "../src/index.js"

const example = `
const ch = await tools.slack.slack_search_channels({ query: input.channel, limit: 1, response_format: "concise" });
const m = /\\(([A-Z0-9]+)\\)/.exec(ch.results || "");
if (!m) { return { error: "channel_not_found", channel: input.channel }; }
const channelId = m[1];
const history = await tools.slack.slack_read_channel({ channel_id: channelId, limit: input.limit });
return { channelId, preview: JSON.stringify(history).slice(0, 1500) };
`

describe("Workflow graph analysis", () => {
  test("finds inputs, tools, branches, and returns in a real Workflow", () => {
    const graph = WorkflowGraph.analyze(example)

    expect(graph.parseError).toBeNull()
    expect(graph.nodes.find((node) => node.kind === "input")).toEqual({
      id: "input",
      kind: "input",
      label: "Input",
      fields: ["channel", "limit"],
    })
    expect(graph.nodes.filter((node) => node.kind === "tool")).toEqual([
      expect.objectContaining({ namespace: "slack", tool: "slack_search_channels", assignsTo: "ch" }),
      expect.objectContaining({ namespace: "slack", tool: "slack_read_channel", assignsTo: "history" }),
    ])
    expect(graph.nodes.filter((node) => node.kind === "branch")).toHaveLength(1)
    expect(graph.nodes.filter((node) => node.kind === "return").map((node) => node.label)).toEqual([
      "{ error, channel }",
      "{ channelId, preview }",
    ])
    expect(graph.edges).toContainEqual({ from: "input", to: "tool1", label: "input.channel", kind: "data" })
    expect(graph.edges).toContainEqual({ from: "input", to: "tool2", label: "input.limit", kind: "data" })
    expect(graph.edges.some((edge) => edge.kind === "data" && edge.from === "tool1" && edge.to === "tool2")).toBe(false)
  })

  test("fans Promise.all tool calls out and back into the next step", () => {
    const graph = WorkflowGraph.analyze(`
      const [channels, messages] = await Promise.all([
        tools.slack.list_channels({ query: input.query }),
        tools.gmail.search_messages({ query: input.query }),
      ]);
      return { channels, messages };
    `)
    const tools = graph.nodes.filter((node) => node.kind === "tool")
    const returned = graph.nodes.find((node) => node.kind === "return")

    expect(tools).toHaveLength(2)
    expect(tools.map((node) => node.parallelGroup)).toEqual(["p1", "p1"])
    expect(tools.map((node) => node.assignsTo)).toEqual(["channels", "messages"])
    expect(returned).toBeDefined()
    expect(graph.edges.filter((edge) => edge.kind === "flow" && edge.to === returned?.id).map((edge) => edge.from)).toEqual([
      tools[0]?.id,
      tools[1]?.id,
    ])
  })

  test("returns a parse error instead of throwing", () => {
    const graph = WorkflowGraph.analyze("const broken = ;")

    expect(graph.parseError).toBeString()
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
  })

  test("renders Mermaid with graph node ids", () => {
    const graph = WorkflowGraph.analyze("const value = await tools.den.read({}); return value")
    const mermaid = WorkflowGraph.toMermaid(graph)

    expect(mermaid.startsWith("flowchart TD")).toBe(true)
    for (const node of graph.nodes) expect(mermaid).toContain(node.id)
  })
})
