# Config import: reuse the answers of an earlier import

- Key: `configImportDecisionsFile`
- Deployments: cloud and self-hosted
- Author: benjaminshafii
- Default: off

## What changes

Reviewing a configuration import means answering questions: leave this
person out, point this reference at that team, treat this item as that one,
rename this plugin. Importing the same export again asked all of them again.

With the feature on, a new import starts with the answers of the last
applied import of the same source into the same organization. The plan says
how many answers were reused and from which request, and the review can
change any of them. An invitation is not repeated (the person was invited
then).

The API also has an answers file, for answers kept outside OpenWork:

- `GET /v1/config-blobs/change-requests/:id/decisions` downloads the answers
  given on a request (`format: "openwork.config-decisions"`). Keep it next to
  the export.
- `PUT /v1/config-blobs/change-requests/:id/decisions` accepts that file as
  its body on a later request and gives the same answers.

The file carries matches, reference answers, skips and renames. Deletes,
overwrites of items that changed since, and whether invitation emails are
sent are not carried: they are decided again each time, and what the later
request already says about them is kept.

## Rules

- Same organization only: the answers hold ids of this organization's items.
  A file from another organization is refused (`decisions_other_organization`).
- Same source only: the handles in the answers are the source file's. A file
  given for an export of another organization is refused
  (`decisions_other_source`).
- A replayed answer is planned like one given by hand. "Leave it out" on a
  reference an item can't be imported without (a spend limit's provider, a
  default model's team) is still refused in the plan, so replaying never
  widens who an item applies to.
- Answers about items the later file no longer holds do nothing.
- Nothing new is stored: the answers are read from the earlier request.

## How to try it

Turn it on for one organization in `/admin`. Import an export, answer the
review, apply. Download the answers of that request, upload the same export
again: the plan comes back without open questions. With a file: download the
answers of a request and `PUT` them to another request's decisions.

## Turning it off

A new import starts unanswered. The download route answers 404 `feature_disabled`, and so does a `PUT` whose
body is an answers file. Plain decisions keep working. Files already
downloaded stay valid for when it is turned on again.

## What to watch

`409 decisions_other_source` and `decisions_other_organization` on the
decisions route, and requests that still wait in review after a replay.
