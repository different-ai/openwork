# analytics-project-dimensions — Name a project once and org analytics can filter by it

A team member connects their desktop app to the company's OpenWork Cloud, names their new workspace's project once, and the organization's analytics learn to filter by it — no keys, no slugs, no extra setup.

1. The member pastes their cloud sign-in code into Settings and the desktop app connects to the organization's OpenWork Cloud.

2. Adding a workspace offers one optional Project name under Want more analytics — they type Atlas Billing, and there is no machine value to invent because the server derives the stable key itself.

3. The workspace opens and the member sends their first task, and the app quietly tags the session's usage telemetry with the Atlas Billing project.

4. Moments later the organization's telemetry lists Atlas Billing as a project dimension with a server-derived key, learned purely from the session's events.

5. Analytics filtered to Atlas Billing count this session while the organization-wide view stays complete, so project filters never hide overall adoption.

6. The cloud dashboard's Analytics page feeds its Project selector from the dimensions API, which now offers Atlas Billing with its server key, and choosing it refetches the same project-scoped usage the dashboard renders.
