# Personal agents (`personalAgents`)

- **Feature key:** `personalAgents`
- **Deployments:** cloud
- **Author:** `benjaminshafii`
- **Status:** private alpha. The flag stays off by default and is turned on
  for one organization at a time, on request. OpenWork does not officially
  support it yet. Public guide: `packages/docs/agents/` ("Agents (private
  alpha)").

## What people get

A member can make agents of their own from chat, as many as they want. Each
agent has a name and a brief: one Markdown text that says what the agent
watches or does, how it decides, and how it reports.

An agent works through routines. A routine is a Cloud Automation that belongs
to the agent, so it has a schedule, a run history and a Run now like any other
Automation. Every run starts from the agent's brief, followed by what that
routine does.

The owner can keep an agent away from a connector, or from single tools of a
connector. A run of that agent is not offered those tools and cannot call
them. The owner's own chat and their other Automations are not affected.

Only the owner sees or changes their agents.

## In the app

With the feature on, the sidebar has an Agents section. Its + opens a new
agent's chat: the agent asks what it should do, the member answers in one
message, and one card asks "Start like this?". Saying yes creates the agent,
its first routine and the first run. The run's result appears in the same
chat. Each agent is listed once and keeps one conversation; its name in the
header opens a small panel with an on/off switch, the next run, its routines,
Run now, Share and Settings.

## Sharing

The owner shares an agent with people in the organization as Manager or
Collaborator, and, where the organization lets them, with a team or the whole
organization (always as collaborators). A collaborator can use it and run it,
and asks for a change instead of making it. A manager can also rename it and
add or remove collaborators, but a manager's change to the brief, the tool
settings or a routine is not applied: it becomes a request, and only the owner
approves it, in the agent's chat, after seeing the whole change.

A run someone starts with Run now uses that person's own connections and model
access, and only they can read its result. A routine's scheduled runs act for
the owner. Everyone the agent is shared with can read the answers of scheduled
runs made after they got access, never earlier ones; full receipts stay with
the person the run acted for. The Share window says so, because those answers
can contain information from the owner's accounts.

A second Run now on a routine that is already running waits in line (five can
wait; after that the app says the line is full). A waiting run does not start
if its routine was archived or, for a scheduled run, if the agent has a new
owner. A tool call is refused mid-run when the person the run acts for lost
access, or the agent was paused or archived.

## Allow, Ask, Block

Each tool of a connector is Allow, Ask or Block for the agent. A tool that
only reads is allowed; a tool that can change something asks first. Asking
means the run is refused the tool, the connector is never called, and a card
waits in the chat: Deny, Allow once, Always allow. A yes applies to the next
run. Something the person said the agent must never do ("never post in Slack")
is stored as a Block. Built-in connectors such as Google Workspace, and
OpenWork's own actions that change something, are refused to an agent's run
because they cannot ask yet.

The organization's tool rules sit on top: Blocked wins over everything, Ask
first wins over an agent's Allow (and removes Always allow), and Allow
automatically lets a tool run unless the agent says Ask or Block. A run with
nobody watching still refuses a tool that has to ask.

## Shared logins

Off by default. When an admin allows them, the owner or a manager can lend
their own account on one connection to an agent; everyone's runs of that agent
then use that account on that connection, and teammates see whose it is. The
person running is still the one checked for access, tool rules and approvals.
The lender can always take it back, the owner can remove any loan on their
agent, and a loan ends when the lender stops being owner or manager, leaves
the organization, or the admin turns shared logins off (turning them on again
does not bring loans back).

## For admins

Organization admins get an Agents page in the dashboard: every agent with its
owner, who can use it, how many tools it may change things with, what it cost
this month against its budget, and its last run. They can pause or resume an
agent, cap its monthly budget, move it to another owner and archive it. For an
agent that is already shared they can change which teams or whether the whole
organization can use it, and add it to those members' sidebars; an agent that
is not shared shows "Not shared", and an admin cannot read its brief,
instructions or chats (a new owner after a transfer can read the brief and
instructions). For every agent they choose who can share agents (everyone, or
admins only; existing shares stay), allow shared logins, write rules every run
is told to follow first, set tool rules (Ask first, Allow automatically,
Blocked), set the most any agent may spend in a month, and read who changed
what. A pause or an organization rule applies at once, also to a run that is
already going.

## What is built so far

Not built yet:

- team-level tool rules: only the organization sets them
- binding Allow once to one routine and one account: it covers the requester's
  next run of the agent
- paging the app's agent list past 50 agents

- resuming the run that asked: a yes starts a new run
- asking for built-in connectors
- telling people when something waits for them or a run finishes
- daily budgets, and choosing whether the member or the organization pays
- a hard budget: the limit is checked before a run starts, not during it
- the same chat on another computer: the cloud keeps which chat belongs to
  which agent per workspace, not the messages
- running a routine on the owner's desktop

## Diagrams

### The primitives

```mermaid
flowchart TB
  subgraph Agent["Agent (owned by one member)"]
    Brief["Brief (versioned)"]
    Memory["Memory: notes + what each routine did last"]
  end
  Routine["Routine = an Automation with a schedule"]
  Run["Run (fresh runner conversation)"]
  Share["Shared with: people, teams, the organization"]
  Rules["Tool permissions: Allow, Ask, Block<br/>organization, team, member, agent"]
  Approval["Approval: Deny or Allow once"]
  Admin["Admin: pause, budget, who can share, written rules"]
  Agent -->|has| Routine
  Routine -->|starts| Run
  Run -->|reads and writes| Memory
  Run -->|every connector tool call| Rules
  Rules -->|Ask| Approval
  Share -->|can run and chat| Agent
  Admin -->|applies to every| Agent
```

### One run

```mermaid
sequenceDiagram
  participant S as Schedule or Run now
  participant D as Den
  participant R as Runner
  participant C as Connector
  participant P as Person
  S->>D: start the routine
  D->>D: admit: feature on, agent not paused, budget, the person still has access
  D->>R: organization rules, brief, task, memory
  R->>D: use a tool
  D->>D: tool permissions: a block wins, then ask, then allow
  alt allowed
    D->>C: call with the account of the person the run acts for
    C-->>R: result
  else ask
    D-->>R: refused, a person has to say yes
    D->>P: approval card: Deny or Allow once
  else blocked
    D-->>R: refused
  end
  R->>D: remember a note, note progress
  R-->>D: answer
  D->>D: save the answer and what this routine did
```

### Whose account

```mermaid
flowchart LR
  Scheduled["Scheduled run"] --> Owner["Owner's accounts"]
  Manual["Run now by Priya"] --> Hers["Priya's accounts"]
  Lent["Sam lent his Linear login to the agent"] --> Sams["Sam's Linear account, for everyone's runs on that connection"]
  Owner --> Check["Tool permissions are checked for the person the run acts for"]
  Hers --> Check
  Sams --> Check
```

## How it works

- `personal_agent` holds the agent; `personal_agent_revision` holds each
  version of its definition: the brief (encrypted like Automation
  instructions), the tool policy, the default placement and the monthly budget.
- `automation.agent_id` marks an Automation as a routine.
  `automation_revision.agent_revision_id` pins the agent version that revision
  runs with. Changing the agent's definition makes the next version and gives
  each routine a new revision that pins it; a run already started keeps the
  version it began with. Archiving the agent archives its routines.
- `/v1/personal-agents` creates, lists, reads, changes and archives agents,
  creates and lists routines, and runs an agent now. Each route is also an
  OpenWork Connect capability.
- With the feature off for an organization the routes answer 404 and the
  capabilities are not listed. Routines that already exist keep their brief and
  tool limits.
- A run adds the pinned brief in front of the routine's instructions. Blocked
  connections and tools become scopes on the run's credential, the same way an
  admin keeps a connection from Workbot, so search, direct calls and Code Mode
  all leave them out. A run that cannot be limited this way does not start.

- In the app, a chat that belongs to an agent is an ordinary session. The chat
  model offers the agent through `agent.propose`, which only draws the card;
  the app calls `/v1/personal-agents` when the member says yes. The app code
  is `apps/app/src/react-app/domains/agents/`.

- Sharing is `personal_agent_share`; requests are `personal_agent_request`;
  team and organization access is `personal_agent_audience`; a lent
  account is `personal_agent_shared_login`; the admin's rules (who can share,
  shared logins, written rules, tool rules, budget) are
  `personal_agent_org_policy`; who changed what is
  `personal_agent_event`. `automation_run.acting_member_id` is the person a
  run acts for. A run's cost comes from the gateway model's rates.

## Verify

`ee/apps/den-api/test/api/personal-agents.api.test.ts`,
`personal-agent-sharing.api.test.ts`, `personal-agent-permissions.api.test.ts`
and `personal-agent-admin.api.test.ts` cover the flag, versions, roles, whose
account a run uses, ask and its decisions, organization blocks, pause, budget
and the admin routes. `personal-agent-audience.api.test.ts` covers team and
organization access, the sidebar and who can share;
`personal-agent-org-rules.api.test.ts` covers organization rules, tool rules
and shared logins; `personal-agent-concurrency.api.test.ts` covers the run
queue, scheduled runs acting for the owner and waiting work that must not
start. Run them one file at a time. `apps/app/tests/personal-agent-*.test.ts` cover what
saying yes does and the app's own rules.
