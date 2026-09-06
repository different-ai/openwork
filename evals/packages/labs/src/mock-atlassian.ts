import type { MockMcpTool } from "./mock-mcp.ts";

export const confluenceResourceUri = "ui://atlassian/confluence-page/view.html";
export const jiraResourceUri = "ui://atlassian/jql-search/view.html";
export const confluenceTileTitle = "Confluence page";
export const jiraTileTitle = "Jira queue";
export const pastedConfluenceJson = `{"pageId": "1122334455"}`;
export const pastedJqlJson = `{ "jql": "project = HELPDESK AND status NOT IN (\\"Closed\\", \\"Resolved\\", \\"Duplicate\\", \\"Declined\\", \\"Spam\\") AND assignee = currentUser() ORDER BY updated ASC" }`;
export const expectedJql = 'project = HELPDESK AND status NOT IN ("Closed", "Resolved", "Duplicate", "Declined", "Spam") AND assignee = currentUser() ORDER BY updated ASC';

const APP_HTML = "<!doctype html><html><head></head><body>Atlassian</body></html>";


/** Provider-shaped MCP Apps: a real RPC rejection for missing input, a successful control otherwise. */
export const atlassianAppTools: MockMcpTool[] = [
  { name: "getConfluencePage", title: "Get Confluence page", argument: "pageId", resourceUri: confluenceResourceUri },
  { name: "searchJiraIssuesUsingJql", title: "Search Jira issues using JQL", argument: "jql", resourceUri: jiraResourceUri },
].map(({ name, title, argument, resourceUri }) => ({
  name,
  title,
  description: title,
  inputSchema: {
    type: "object",
    properties: { cloudId: { type: "string" }, [argument]: { type: "string" } },
    required: ["cloudId", argument],
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
  _meta: { ui: { resourceUri, visibility: ["model", "app"] } },
  appHtml: APP_HTML,
  validateRequiredArguments: true,
  result: { content: [{ type: "text", text: `ok:${name}` }] },
}));
