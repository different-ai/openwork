# OpenWork Diagnostics wire history

1. A private-cloud administrator starts the controlled egress diagnostic from Org settings, then gives OpenWork support one run ID. The support dashboard groups only the requests from that run, making it clear which traffic actually reached the public service.

2. The run tests public reachability, HEAD, OPTIONS, authenticated JSON POST, a same-origin redirect, OAuth metadata, and a synthetic token exchange. Each network boundary has its own step and diagnostic reference, while shared secrets and issued tokens remain absent from the evidence.

3. The same run continues through MCP initialize, the ready notification, tool discovery, and a content-free tool call. Separate entries prove session and protocol continuity without retaining the tool argument or MCP session token.

4. A proxy-style failure that strips authorization now appears as HTTP 401 on the exact authenticated POST step. Den stops at that layer and suggests the next owner and action; if the dashboard has no matching request at all, the failure happened before HTTP reached OpenWork.
