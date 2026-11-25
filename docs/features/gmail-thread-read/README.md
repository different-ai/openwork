# Read Gmail threads

`gmailThreadRead` is off by default on cloud and self-hosted deployments. Owner: `yomgui`.

Enable it for a test organization, then connect Google Workspace with Gmail read access. Search for "Gmail thread" and pass a thread ID from a Gmail message. The result lists message headers, snippets, and label IDs in Gmail timestamp order without downloading message bodies.

Turning it off hides the thread-read tool and blocks new thread-read requests. Message search and single-message reads continue to work. No mailbox state is changed and no extra OAuth scope is required. Watch for connection errors (409) and Google upstream errors (502) when checking rollout health.
