# primitives-80-20 — Simplify OpenWork primitives without changing the user experience

1. OpenWork launches into the existing workspace without migration warnings, broken navigation, or unexpected visual changes. The cleanup is invisible to the user because existing workflows remain intact.

2. The workspace’s session list loads and an existing conversation opens normally. Messages, code blocks, links, and formatted Markdown render consistently through the supported presentation path.

3. The user starts a new session and sends a prompt. OpenWork connects to the correct workspace server, the session appears in the sidebar, and the response streams into the conversation as before.

4. The user opens workspace settings and visits connections and extensions. Existing configuration loads through the same server-backed experience, with no stale or duplicate UI paths exposed.

5. After restarting OpenWork, the workspace, sessions, settings, and server connection return correctly. The refactoring has simplified the system’s primitives without changing the user’s durable state or expected behavior.
