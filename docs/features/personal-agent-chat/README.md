# Standing agent chat

Standing chats use the existing Cloud-only `personalAgents` flag. Verify the flow in an isolated test organization.

## Access boundary

The chat identity belongs to Den: it is bound to the organization, agent and signed-in member. The agent executes in the restricted headless runner, not in an OpenCode workspace session. A missing runner, expired credential or revoked membership must stop the turn rather than reroute it. The connector gateway checks access at each call, including calls for tools the model saw earlier. The chat never receives a workspace tool catalog or the member's general connector credentials.

## Verification

1. Start a new agent with Linear off. From its standing chat, ask it to list issues. Check that the tool is absent from discovery and that no provider call occurs. The agent should be able to ask for Linear by name.
2. In the visible approval card, turn on Linear. Confirm the card reflects the decision, then send an explicit follow-up. Confirm the connector read succeeds and count the provider calls. Turning on the connector does not authorize a write.
3. Turn Linear off and ask again. Confirm the prior catalog and decision do not authorize a new call. Verify Den fails closed when the runner is unavailable, the turn has ended, the member lost access, or the caller uses a different organization or member.
4. Check that routine approvals still use their own run identity, that one-time grants are not interchangeable between chat and routine runs, and that flag-off and ordinary workspace chats are unaffected.

Capture the permissions switches, chat header when an app is enabled, empty header, approval card and successful follow-up at real size. Screenshots show what the person sees; gateway assertions establish what reached the provider.

Approving a connector does not replay a message. Send a new message to continue unless the runner supports safe same-turn continuation.
