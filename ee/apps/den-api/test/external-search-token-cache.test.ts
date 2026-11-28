import assert from "node:assert/strict"
import test from "node:test"

import { createToolTokenCache, scoreExternalTool, selectExternalMcpSearchConnections } from "../src/mcp/external-search-selection.js"
import { scoreText, tokenize } from "../src/mcp/search.js"

function expectedScore(connectionName: string, tool: { name: string; title?: string; description?: string }, query: string): number {
  return scoreText(tokenize(`${connectionName} ${tool.name}`), tokenize(tool.description ?? tool.title ?? tool.name), tokenize(query))
}

test("scoreExternalTool matches scoreText on first and repeated calls", () => {
  const connection = "Work"
  const tools = [
    { name: "create_issue", description: "Creates a new issue in a project" },
    { name: "postEmail", description: "thing" },
    { name: "get_user", description: "Returns one account" },
    { name: "list_projects", description: "Lists all projects" },
    { name: "send_message", title: "Send a message" },
  ]
  const queries = [
    "ticket",
    "open a ticket",
    "send mail",
    "add issue",
    "find teammate",
    "proj",
    "projects",
    "create_issue",
    "CreateIssue",
    "nothing matches",
  ]
  for (const tool of tools) {
    for (const query of queries) {
      const queryTokens = tokenize(query)
      const expected = expectedScore(connection, tool, query)
      assert.equal(scoreExternalTool(connection, tool, queryTokens), expected)
      assert.equal(scoreExternalTool(connection, tool, queryTokens), expected)
    }
  }
})

test("synonym matches keep exact regression scores", () => {
  assert.equal(scoreExternalTool("Work", { name: "create_issue", description: "Creates a new issue in a project" }, tokenize("ticket")), 4)
  assert.equal(scoreExternalTool("Work", { name: "postEmail", description: "thing" }, tokenize("send mail")), 6)
  assert.equal(scoreExternalTool("Work", { name: "get_user", description: "Returns one account" }, tokenize("find teammate")), 3)
})

test("prefix matches keep exact regression scores", () => {
  assert.equal(scoreExternalTool("Work", { name: "list_projects", description: "Lists all projects" }, tokenize("proj")), 3)
})

test("selectExternalMcpSearchConnections keeps cached order, tie order, and limit", () => {
  const connections = Array.from({ length: 20 }, (_, index) => ({
    name: `conn_${String(index).padStart(2, "0")}`,
    tools: [{ name: "find_issues", description: "Find issues" }],
  }))
  const cachedTools = (connection: { name: string; tools: { name: string; description: string }[] }) => connection.tools
  const queryTokens = tokenize("issues")
  const first = selectExternalMcpSearchConnections(connections, queryTokens, 20, cachedTools)
  const second = selectExternalMcpSearchConnections(connections, queryTokens, 20, cachedTools)
  assert.deepEqual(first, second)
  assert.equal(first.length, 16)
  assert.deepEqual(first.map((connection) => connection.name), connections.slice(0, 16).map((connection) => connection.name))
})

test("scoreExternalTool refreshes cached tokens when description, title, or name changes", () => {
  const connection = "Work"
  const queryTokens = tokenize("create")

  const described = { name: "get_issue", description: "Get issue" }
  const oldDescriptionScore = scoreExternalTool(connection, described, queryTokens)
  described.description = "Create issue"
  const newDescriptionScore = scoreExternalTool(connection, described, queryTokens)
  assert.equal(newDescriptionScore, expectedScore(connection, described, "create"))
  assert.notEqual(newDescriptionScore, oldDescriptionScore)

  const titled = { name: "get_issue", title: "Get issue" }
  const oldTitleScore = scoreExternalTool(connection, titled, queryTokens)
  titled.title = "Create issue"
  const newTitleScore = scoreExternalTool(connection, titled, queryTokens)
  assert.equal(newTitleScore, expectedScore(connection, titled, "create"))
  assert.notEqual(newTitleScore, oldTitleScore)

  const named = { name: "get_issue" }
  const oldNameScore = scoreExternalTool(connection, named, queryTokens)
  named.name = "create_issue"
  const newNameScore = scoreExternalTool(connection, named, queryTokens)
  assert.equal(newNameScore, expectedScore(connection, named, "create"))
  assert.notEqual(newNameScore, oldNameScore)
})

test("scoreExternalTool scores the same tool per connection name", () => {
  const tool = { name: "list_projects", description: "Lists all projects" }
  const queryTokens = tokenize("project")

  assert.equal(scoreExternalTool("Acme", tool, queryTokens), expectedScore("Acme", tool, "project"))
  assert.equal(scoreExternalTool("ProjectHub", tool, queryTokens), expectedScore("ProjectHub", tool, "project"))
  assert.equal(scoreExternalTool("ProjectHub", tool, queryTokens), expectedScore("ProjectHub", tool, "project"))
  assert.equal(scoreExternalTool("Acme", tool, queryTokens), expectedScore("Acme", tool, "project"))
})

test("scoreExternalTool scores tools with only a name", () => {
  const connection = "Work"
  const tool = { name: "create_issue" }
  const queryTokens = tokenize("create issue")
  const expected = scoreText(tokenize(`${connection} ${tool.name}`), tokenize(tool.name), queryTokens)
  assert.equal(scoreExternalTool(connection, tool, queryTokens), expected)
  assert.equal(scoreExternalTool(connection, tool, queryTokens), expected)
})

test("tool token cache drops repeated tokens without changing scores", () => {
  const tool = { name: "issue_issue", description: "issue issue create issues" }
  const tokens = createToolTokenCache()("Work", tool)
  assert.deepEqual(tokens.nameTokens, ["work", "issue"])
  assert.deepEqual(tokens.textTokens, ["issue", "create", "issues"])
  for (const query of ["issue", "issues", "create", "iss", "ticket", "work issue"]) {
    assert.equal(scoreExternalTool("Work", tool, tokenize(query)), expectedScore("Work", tool, query))
  }
})

test("tool token cache starts over at its limit and rebuilds equal tokens", () => {
  const cache = createToolTokenCache(4)
  const first = { name: "a", description: "b" }
  const kept = cache("c", first)
  assert.equal(cache("c", first), kept)
  cache("c", { name: "d", description: "e" })
  const rebuilt = cache("c", first)
  assert.notEqual(rebuilt, kept)
  assert.deepEqual(rebuilt, kept)
})

test("tool token cache does not store a tool larger than its limit", () => {
  const cache = createToolTokenCache(2)
  const tool = { name: "a", description: "b" }
  const first = cache("c", tool)
  const second = cache("c", tool)
  assert.notEqual(second, first)
  assert.deepEqual(second, first)
})
