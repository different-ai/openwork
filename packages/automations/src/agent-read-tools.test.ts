import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  allowedAgentReadTools,
  classifyAgentTool,
  decideAgentReadTool,
  decideNativeReadOperation,
  reviewedReadTool,
  toolNameWords,
} from "./agent-read-tools.ts"

// A connector nobody reviewed: a custom MCP (fictional).
const CUSTOM = "https://mcp.acme-tickets.test/mcp"
const LINEAR = "https://mcp.linear.app/mcp"
const SLACK = "https://mcp.slack.com/mcp"

describe("the classifier: a tool's name and description when its provider says nothing", () => {
  // Real-looking tool names from common MCP servers, with what they must be.
  const FIXTURES: [string, "read" | "write" | "unclear", string?][] = [
    ["list_issues", "read"],
    ["get_issue", "read"],
    ["search_messages", "read"],
    ["read_channel", "read"],
    ["fetch_page", "read"],
    ["query_database", "read"],
    ["find_contact", "read"],
    ["describe_table", "read"],
    ["view_invoice", "read"],
    ["show_logs", "read"],
    ["lookup_user", "read"],
    ["getIssueComments", "read"],
    ["ListPullRequests", "read"],
    ["notion-search", "read"],
    ["slack_read_thread", "read"],
    ["hubspot.search_contacts", "read"],
    ["get_email", "read"],
    ["list_runs", "read"],
    ["get_workflow_run", "read"],
    ["get_commit", "read"],
    ["get_post", "read"],
    ["list_project_updates", "read"],
    // The tricky ones: a read word and a write in the same name.
    ["get_or_create_customer", "write"],
    ["getOrCreateUser", "write"],
    ["search_and_replace", "write"],
    ["mark_read", "write"],
    ["read_and_mark_as_read", "write"],
    ["send_digest", "write"],
    ["run_query", "write"],
    ["execute_sql", "write"],
    ["fetch_and_update_record", "write"],
    ["list_and_delete_stale", "write"],
    ["post_message", "write"],
    ["slack_post_message", "write"],
    ["create_issue", "write"],
    ["update_ticket", "write"],
    ["delete_file", "write"],
    ["archive_thread", "write"],
    ["move_card", "write"],
    ["invite_user", "write"],
    ["pay_invoice", "write"],
    ["write_file", "write"],
    ["email_customer", "write"],
    ["comment_on_issue", "write"],
    ["approve_pull_request", "write"],
    ["toggle_feature_flag", "write"],
    ["get_project_update", "write"],
    // Unsure is no.
    ["download_file", "unclear"],
    ["count_issues", "unclear"],
    ["check_status", "unclear"],
    ["issues", "unclear"],
    ["getorcreatecustomer", "unclear"],
    ["preview_invoice", "unclear"],
  ]
  for (const [name, expected] of FIXTURES) {
    test(`${name}: ${expected}`, () => assert.equal(classifyAgentTool({ name }), expected))
  }

  test("a description that writes makes a read-looking name a write", () => {
    assert.equal(classifyAgentTool({ name: "get_customer", description: "Gets a customer by email, or creates one if none exists." }), "write")
    assert.equal(classifyAgentTool({ name: "fetch_page", description: "Fetches a page and marks it as read." }), "write")
    assert.equal(classifyAgentTool({ name: "sync_view", description: "Sends the current view to every subscriber." }), "write")
    assert.equal(classifyAgentTool({ name: "list_tickets", description: "Use this to update ticket priorities in bulk." }), "write")
  })

  test("a description that only reads leaves a read a read", () => {
    assert.equal(classifyAgentTool({ name: "list_tickets", description: "Lists open tickets, newest first, with their latest updates." }), "read")
    assert.equal(classifyAgentTool({ name: "search_posts", description: "Search posts and comments in a workspace." }), "read")
  })

  test("names split on separators and camelCase", () => {
    assert.deepEqual(toolNameWords("getOrCreateUser"), ["get", "or", "create", "user"])
    assert.deepEqual(toolNameWords("HTTPGetStatus"), ["http", "get", "status"])
    assert.deepEqual(toolNameWords("notion-get-comments"), ["notion", "get", "comments"])
  })
})

describe("the decision for one tool", () => {
  const decide = (tool: Parameters<typeof decideAgentReadTool>[0]["tool"], override: "allow" | "deny" | null = null, connectionUrl = CUSTOM) =>
    decideAgentReadTool({ connectionUrl, tool, override })

  test("annotations: read-only and not destructive is allowed", () => {
    assert.deepEqual(decide({ name: "frobnicate_widgets", annotations: { readOnlyHint: true } }), { allowed: true, reason: "marked_read", locked: false })
  })

  test("annotations: read-only but destructive is never allowed, even by an admin", () => {
    assert.deepEqual(decide({ name: "list_tickets", annotations: { readOnlyHint: true, destructiveHint: true } }), { allowed: false, reason: "destructive", locked: true })
    assert.deepEqual(decide({ name: "list_tickets", annotations: { readOnlyHint: true, destructiveHint: true } }, "allow"), { allowed: false, reason: "destructive", locked: true })
  })

  test("annotations: not read-only is denied, whatever its name says", () => {
    assert.deepEqual(decide({ name: "list_tickets", annotations: { readOnlyHint: false } }), { allowed: false, reason: "marked_write", locked: false })
  })

  test("annotations decide before the name, but a read-only label never clears a name that says it writes", () => {
    assert.deepEqual(decide({ name: "ticket_summary", annotations: { readOnlyHint: true } }), { allowed: true, reason: "marked_read", locked: false }, "an unclear name: the label decides")
    assert.deepEqual(decide({ name: "close_ticket", annotations: { readOnlyHint: true } }), { allowed: false, reason: "write_name", locked: false }, "conflicting signals: no")
    assert.deepEqual(decide({ name: "get_customer", description: "Gets a customer, or creates one.", annotations: { readOnlyHint: true } }), { allowed: false, reason: "write_name", locked: false })
    assert.deepEqual(decide({ name: "close_ticket", annotations: { readOnlyHint: true } }, "allow"), { allowed: true, reason: "admin_allowed", locked: false }, "an admin can still allow it")
  })

  test("annotations without readOnlyHint fall back to the name", () => {
    assert.deepEqual(decide({ name: "list_tickets", annotations: { destructiveHint: false } }), { allowed: true, reason: "read_name", locked: false })
    assert.deepEqual(decide({ name: "close_ticket", annotations: {} }), { allowed: false, reason: "write_name", locked: false })
    assert.deepEqual(decide({ name: "count_tickets" }), { allowed: false, reason: "unclear", locked: false })
  })

  test("an admin's choice wins over annotations and names", () => {
    assert.deepEqual(decide({ name: "run_query", annotations: { readOnlyHint: false } }, "allow"), { allowed: true, reason: "admin_allowed", locked: false })
    assert.deepEqual(decide({ name: "list_tickets", annotations: { readOnlyHint: true } }, "deny"), { allowed: false, reason: "admin_denied", locked: false })
  })

  test("a reviewed list wins over annotations and names, and an admin wins over it", () => {
    assert.deepEqual(decide({ name: "list_issues" }, null, LINEAR), { allowed: true, reason: "reviewed", locked: false })
    // Linear marks save_issue read-only by mistake: the reviewed list still says no.
    assert.deepEqual(decide({ name: "save_issue", annotations: { readOnlyHint: true } }, null, LINEAR), { allowed: false, reason: "not_reviewed", locked: false })
    assert.deepEqual(decide({ name: "list_issue_statuses" }, "deny", LINEAR), { allowed: false, reason: "admin_denied", locked: false })
    assert.deepEqual(decide({ name: "search_issues_semantic" }, "allow", LINEAR), { allowed: true, reason: "admin_allowed", locked: false })
  })

  test("the reviewed lists themselves are unchanged (the feature off)", () => {
    assert.equal(reviewedReadTool(SLACK, { name: "slack_read_thread" }), true)
    assert.equal(reviewedReadTool(SLACK, { name: "slack_send_message" }), false)
    assert.equal(reviewedReadTool(CUSTOM, { name: "list_tickets" }), false, "a service without a reviewed list: nothing")
  })

  test("only the allowed names are handed to the check", () => {
    const tools = [
      { name: "list_tickets", annotations: { readOnlyHint: true } },
      { name: "get_ticket" },
      { name: "close_ticket" },
      { name: "purge_queue", annotations: { readOnlyHint: true, destructiveHint: true } },
      { name: "run_query" },
    ]
    assert.deepEqual(allowedAgentReadTools({ connectionUrl: CUSTOM, tools }), ["list_tickets", "get_ticket"])
    assert.deepEqual(allowedAgentReadTools({ connectionUrl: CUSTOM, tools, overrides: { run_query: "allow", get_ticket: "deny", purge_queue: "allow" } }), ["list_tickets", "run_query"])
    assert.deepEqual(allowedAgentReadTools({ connectionUrl: CUSTOM, tools: [{ name: "run_report", annotations: { readOnlyHint: true } }] }), [], "a read-only label on a name that runs something")
  })
})

describe("Den's own operations", () => {
  test("a GET reads; an admin may turn it off", () => {
    assert.deepEqual(decideNativeReadOperation({ method: "GET" }), { allowed: true, reason: "native_read", locked: false })
    assert.deepEqual(decideNativeReadOperation({ method: "get", override: "deny" }), { allowed: false, reason: "admin_denied", locked: false })
  })
  test("anything else never reads, whoever allows it", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.deepEqual(decideNativeReadOperation({ method, override: "allow" }), { allowed: false, reason: "native_write", locked: true })
    }
  })
})
