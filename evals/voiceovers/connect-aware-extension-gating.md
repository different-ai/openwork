# Connect-aware legacy extension gating — internal demo

The collision: OpenWork ships two Google Workspace integrations. The legacy
per-device "extensions" path always advertises 14 Google Workspace actions to
the agent, even when the device has no OAuth client configured — so agents run
`status`, read "missing OAuth client secret", and tell connected-via-Cloud
users to reconnect in Settings > Extensions. This demo proves the fix: an
org-level `connectEnabled` switch that removes the dead tools, redirects the
agent to OpenWork Cloud, and never touches a device where the legacy path is
actually configured.

1. This is a fresh device: the org has not enabled Connect, and no legacy Google OAuth client is configured. The legacy extension surface offers every action it always has — Google Workspace and image generation side by side — byte-for-byte the behavior shipped today.

2. Now the organization flips one switch: connect enabled. This is the exact endpoint the desktop app pushes when the org's cloud config arrives — one boolean, stored server-side, effective on the very next request.

3. The tool surface transforms. The thirteen Google Workspace actions that could only fail on this device are gone; the safe status probe stays; and image generation — which has no cloud equivalent — is untouched. The agent can no longer stumble into a dead end.

4. If an agent still calls a hidden Google Workspace action, it no longer gets an OAuth error to misread. It gets a redirect: use OpenWork Cloud's search and execute capabilities, and if the user needs to connect, send them to Settings > Connect — never Settings > Extensions.

5. The status probe itself now carries the same guidance, so even an agent that only checks status walks away with the correct next step instead of a missing-client-secret diagnosis.

6. And it is a real kill switch: flip the flag off and the full legacy surface is back on the next request — no restart, no reinstall, nothing lost for teams that are not ready.

7. Behind it all is the surface users are actually pointed to: Settings > Connect, where Google Workspace and the rest of the org's connections live in the cloud, connected once per member.
