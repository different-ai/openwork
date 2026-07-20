# mcp-tool-calling-surfaces — Run the same MCP tool wherever an admin finds the connection

Cast: Alex, an Acme Robotics workspace admin, in OpenWork Cloud. The Route
Verification MCP is a real protocol-compatible local test server with one safe,
read-only tool and a deterministic response. It is connected and shared
org-wide, so both screens operate within the same rollout and use-grant policy.

1. Alex opens Connectors with the org-wide MCP already connected. The connection menu still offers Run a tool directly; he opens View tools instead, uses the Run a tool button inside that catalog, sends a safe verification call, and sees the completed result from the real upstream server.

2. Alex opens Your Connections, where the same org-wide connector is available under his use grant. The same manual runner invokes the same MCP tool again, and its result confirms both entry points reach the real upstream tools/call path without bypassing connection access policy.
