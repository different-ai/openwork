# Cloud coding gateway

A one-time setup code grants a task token. The token is scoped to the task's repository and member. Den checks current access on every call and only issues GitHub credentials with repository-scoped read access. Den builds and verifies the approved commit before creating a new branch with the member's GitHub identity.

Decision routes for signed-in members live under `routes/org/cloud-coding-approvals.ts`. Neither the setup code nor the task token can decide an approval.
