# tool-tester-page — Test any MCP tool on a full page, and switch risky ones off for the whole org

Den's tool tester graduates from a cramped row expander to a dedicated admin page,
and tool governance becomes real: admins disable individual tools (or a whole
connection) at the Micx layer, enforced server-side for agents and members alike.

1. From Your Connections, the wrench on a connection now opens the Tool Tester — a full page, not a cramped row expander.

2. Sarah, an admin, picks the connection, searches its tools, and selects one; the arguments render as a real form generated from the tool's schema.

3. She runs it and gets one clear verdict: a trace pipeline — Micx, HTTP 200, tool result — with the result front and center and the raw request and response one tab away.

4. A tool whose schema can't form-render just falls back to the JSON editor — nothing breaks, the segmented control simply lands on JSON.

5. A riskier tool gets its switch flipped off, and it's disabled for the whole organization with Sarah's name on the audit note.

6. An agent tries it anyway: the call comes back policy_blocked, straight from the server — not hidden UI, real enforcement.

7. The org kill switch takes the whole connection dark in one move, and every run stays in this browser session only — never in Micx logs.
