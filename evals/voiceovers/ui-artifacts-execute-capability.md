# UI artifacts — an execute-capability lifecycle

This demo follows deterministic mock data through the same two-tool cloud surface available to any compatible agent engine. It first proves the alpha is inert while disabled, then shows artifact discovery, composable widget rendering, multiple calendar presentations, explicit approval, state replacement, and stale-revision protection without contacting a live provider.

1. UI Artifacts is off by default. Agent initialization never carries persistent artifact steering; enabled suggestions inject bounded guidance only into that turn. With the member preference disabled, artifact capabilities cannot be discovered or executed, the right-rail entry is absent, and an artifact-shaped tool receipt stays in the ordinary chat renderer.

2. After the member opts in, UI Artifacts appears in the right rail. The member can inspect seven standard chat-native patterns, including a variant-driven Calendar and a composable Widgets collection, then decide which ones the agent is allowed to suggest and render.

3. Widgets is one artifact, not a growing set of one-off cards. This example combines a metric, progress, service status, leave balance, and payroll date in a single grid. The schema also supports strip and stack layouts, so the agent can compose only the widgets relevant to the answer.

4. Calendar is also one artifact with variants. The day view prioritizes a chronological timeline and keeps the best focus window visible beneath today’s meetings.

5. With the same calendar event contract, the agenda variant groups events across a date range. It removes day-only focus guidance and makes the next meeting across multiple days easy to scan.

6. The week variant changes the layout again, grouping the same event objects into compact date cards. The agent chooses a variant through the searched schema instead of discovering a new tool for every presentation.

7. Behind the scenes, the agent still kept OpenWork Cloud to search capabilities and execute capability. A workspace brief can remain a higher-level answer for broad requests while Calendar and Widgets stay independently reusable for focused requests.

8. An approval is rendered as mock data at revision one with both choices visible. Nothing has changed yet: the card is waiting for the member to make an explicit decision.

9. Clicking Approve still does not execute anything silently. It stages a visible, minimal request containing only the artifact instance, selected item, decision, and expected revision, while clearly forbidding a live provider action.

10. Once that exact request is executed, the same artifact instance is replaced by revision two and the selected item becomes approved. The mock MCP has also rejected a stale revision-one replay, proving that an old card cannot overwrite newer state.
