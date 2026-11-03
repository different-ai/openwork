import assert from "node:assert/strict"
import { test } from "node:test"
import { EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT, selectExternalMcpSearchConnections } from "../src/mcp/external-search-selection.js"
import { scoreText, tokenize } from "../src/mcp/search.js"

const tools = [
  { connection: "Gmail", name: "searchMessages", description: "Search the member's Gmail messages with Gmail query syntax." },
  { connection: "Google Calendar", name: "createEvent", description: "Create a Google Calendar event with attendees." },
  { connection: "Google Drive", name: "searchFiles", description: "Search Google Drive files by name or full text." },
  { connection: "Linear", name: "create_issue", description: "Create a new Linear issue." },
  { connection: "Linear", name: "list_cycles", description: "Retrieve cycles for a specific Linear team." },
  { connection: "Slack", name: "slack_get_users", description: "Get a list of all users in the workspace." },
  { connection: "Slack", name: "slack_reply_to_thread", description: "Reply to a specific message thread in Slack." },
]

/** Best match first, scored the way an external MCP probe scores provider tools. */
function top(query: string): string | undefined {
  return tools
    .map((tool) => ({ tool: `${tool.connection}:${tool.name}`, score: scoreText(tokenize(`${tool.connection} ${tool.name}`), tokenize(tool.description), tokenize(query)) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)[0]?.tool
}

test("camelCase provider tool names split into words", () => {
  assert.deepEqual(tokenize("searchMessages"), ["search", "messages"])
  assert.deepEqual(tokenize("createConfigObject"), ["create", "config", "object"])
  assert.equal(top("search messages"), "Gmail:searchMessages")
})

test("plurals, synonyms, and filler words find the capability people mean", () => {
  assert.equal(top("unread emails"), "Gmail:searchMessages")
  assert.equal(top("schedule a meeting"), "Google Calendar:createEvent")
  assert.equal(top("create ticket"), "Linear:create_issue")
  assert.equal(top("find document"), "Google Drive:searchFiles")
  assert.equal(top("teammates"), "Slack:slack_get_users")
  assert.equal(top("this sprint"), "Linear:list_cycles")
})

test("a synonym ranks below the word itself, and filler words never prefix-match", () => {
  const direct = scoreText(tokenize("create issue"), [], tokenize("create issue"))
  const synonym = scoreText(tokenize("create issue"), [], tokenize("create ticket"))
  assert.ok(direct > synonym && synonym > 0)
  assert.equal(scoreText(tokenize("list today tokens"), [], tokenize("to me")), 0)
  assert.equal(scoreText(tokenize("prepare app"), [], tokenize("pr")), 0)
})

test("connections are chosen by their recently listed tools, not only their names", () => {
  const connections = [
    ...Array.from({ length: EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT + 3 }, (_, index) => ({ name: `Service ${index}` })),
    { name: "Linear" },
  ]
  const query = tokenize("my open issues")
  assert.ok(!selectExternalMcpSearchConnections(connections, query).some(({ name }) => name === "Linear"))
  const selected = selectExternalMcpSearchConnections(connections, query, EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT,
    (connection) => connection.name === "Linear" ? [{ name: "list_issues", description: "List issues in the workspace." }] : undefined)
  assert.equal(selected.length, EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT)
  assert.equal(selected[0]?.name, "Linear")
})
