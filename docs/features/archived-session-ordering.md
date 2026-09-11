# Archived session ordering

Investigation: 2026-09-10. Baseline: `2fcbae60e`.

## Finding and root cause

The sidebar's global Archived section concatenated each workspace's archived
sessions in workspace order, preserving the fetched order within each workspace.
Clicking Archived expanded that array; it did not fetch or sort it. Consequently,
moving a workspace could move whole blocks of archived conversations, and a
newly archived conversation was not guaranteed to appear first.

The global archive aggregation dates to the sidebar redesign in #3064. It
combined formerly workspace-specific archives without defining a global sort.
This is an accidental presentation dependency, not evidence that the engine
sorts archives by any particular timestamp. Complete inventory loading beyond
200 sessions was already addressed by #4783 and is not this defect.

Existing product documentation defined archive as non-destructive filing, but
did not specify ordering. Internal design discussion supported a global archive,
not a particular comparator. No explicit sorting decision was found in the
scoped public-channel searches. Relevant design pointer:
https://differentai.slack.com/archives/C0AJU2NQJEB/p1784806678645529

## Options and decision

| Default | Advantage | Cost |
| --- | --- | --- |
| Most recently archived | Predictable recovery: the conversation just filed is at the top | Bulk cleanup puts old conversations ahead of recently active work |
| Last activity | Familiar conversation-history ordering | An old conversation archived now can disappear far down the list; activity must be defined |
| Name A–Z | Useful for named reference collections | Generated titles are weak retrieval cues; hides recency |
| Manual order | Curated reference library | Extra state and maintenance; duplicates groups/pins |
| Workspace/fetched order | No implementation change | Accidental global ordering changes when unrelated workspace order changes |

**Decision:** most recently archived first, globally. Use `time.archived`
descending, then workspace ID and session ID ascending for deterministic ties.
Opening an archive or changing its last-update timestamp does not reorder it.
Restoring removes it; rearchiving uses its new archive timestamp. Keep membership
(including archived children), active manual ordering, groups, pins, and fetching
unchanged. No sort selector, persistence migration, or new archive metadata is
needed. The existing row hover continues to show last activity, not archive age;
an explicitly labeled archive date is a possible later design improvement.

This is the recommendation adopted for this fix, not a claim of design-team
approval or an industry-standard archive comparator.

## Public product precedents

Official documentation reviewed on 2026-09-10 distinguishes useful patterns from
unverified defaults:

- **Slack:** archived channels are discoverable through a directory filter and
  search. [Later](https://slack.com/help/articles/360042650274-Save-messages-and-files-for-later)
  separates Archived reference material from Completed tasks: filing is not proof
  that work succeeded. Sidebar sections offer A–Z, Recency, and Priority, but
  those are not documented archive-list defaults.
  [Channels](https://slack.com/help/articles/213185307-Archive-or-delete-a-channel),
  [sidebar sorting](https://slack.com/intl/en-gb/help/articles/360043207674-Organise-your-sidebar-with-customised-sections).
- **ChatGPT:** archives are managed in Settings and remain searchable. The
  reviewed help does not specify archive-list sorting.
  [Archive](https://help.openai.com/en/articles/8809935-how-to-delete-and-archive-chats-in-chatgpt),
  [search](https://help.openai.com/en/articles/10056348-how-do-i-search-my-chat-history-in-chatgpt).
- **Codex:** archived threads are managed in Settings; restoring returns a thread
  to its original sidebar location. Archive ordering is unspecified in the
  [reviewed documentation](https://developers.openai.com/codex/app/troubleshooting).
- **Claude:** project archiving retains conversations, but project-level behavior
  is not proof of individual-chat sorting. Archive order is unspecified in the
  [reviewed help](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects).
- **Gmail:** archive removes Inbox membership rather than deleting mail. Search
  supports Most relevant and Most recent, not a documented archive-time ordering.
  [Archive](https://support.google.com/mail/answer/6576?hl=en),
  [search](https://support.google.com/mail/answer/6593?hl=en).
- **Linear:** archives retain closed inactive issues; general display settings
  offer several orderings. Neither establishes an archive-specific default.
  [Archive](https://linear.app/docs/delete-archive-issues),
  [display options](https://linear.app/docs/display-options).

The common pattern is reversible filing and retrieval. None of these reviewed
sources establishes a universal newest-archived-first convention.

## Regression proof

`evals/specs/archived-session-sort.e2e.test.ts` drives the real local web surface
and native V1 engine with two isolated workspaces. It observes timestamps that
conflict with creation/update order, clicks Archived, reverses persisted workspace
order and reloads, opens the owning workspace, restores, rearchives, and reloads
again. Removing the comparator makes the ordering assertion fail.

Supplementary `apps/app/tests/archived-session-sort.test.ts` covers membership,
archived children, tie independence, input immutability, and active ordering.
PR-head results and CI status belong in the PR evidence rather than this document.
