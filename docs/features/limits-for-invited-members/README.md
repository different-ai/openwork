# Spend limits for invited people

- **Key:** `limitsForInvitedMembers`
- **Deployments:** OpenWork Cloud and self-hosted
- **Default:** off
- **Author:** [benjaminshafii](https://github.com/benjaminshafii)

No new screen: this changes what an existing action accepts.

## What changes

An admin can assign a spend limit (AI Gateway › Limits) to someone who has been
invited and has not accepted yet. The limit applies from that person's first
request after they join; nobody has to assign it again.

A configuration import (Settings › Config) assigns limits to the people it
invites in the same run. With the feature off, those people are left out of the
limit with a note and the file has to be imported again once they have joined.

## With the feature off

Unchanged behaviour: assigning a limit to an invited person answers
`404 member_not_found`, and an import plans those people as "will not be
assigned yet".

## How it works

An invited person already has a member row (no user yet), and that row keeps its
id when they accept. Limits are enforced by member id, so an assignment made
while the invitation is pending is simply there when they join.

- `POST /v1/gateway/usage-limit-policies/{policyId}/assignments` with a
  `memberId` accepts an invited member when the feature is on for the
  organization.
- A canceled invitation removes its member row, so it can't be given a limit.
- When someone who is already a member accepts an invitation, the invitation's
  placeholder row is deleted; limits assigned to it are moved to the person's
  existing membership. This runs regardless of the feature, so turning it off
  later never strands an assignment.

## How to try

1. Turn the feature on for an organization (`/admin` › Features).
2. Invite someone, then AI Gateway › Limits › a limit › add that person.
3. Have them accept: AI Gateway usage for that person shows the limit.

## Turning it off

Safe at any time. Assignments already made to invited people stay and still
apply when they join; new ones are refused as before.

## What to watch

`member_not_found` on limit assignments (should drop for organizations with the
feature on) and config imports that report "Not assigned to" warnings.

## Proof

`ee/apps/den-api/test/api/gateway-limits-invited-members.api.test.ts`
