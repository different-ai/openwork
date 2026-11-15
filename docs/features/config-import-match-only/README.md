# Config import: only change what already exists

- Key: `configImportMatchOnly`
- Deployments: cloud and self-hosted
- Author: benjaminshafii
- Default: off

## What changes

An import creates what the organization does not hold yet. With the feature
on, a request can be told not to: send `createMissing: false` in the body of
`PUT /v1/config-blobs/change-requests/:id/decisions`. Every item the plan
would create is then blocked, with the reason, until it is matched to an
existing item or left out. Updates are planned as usual.

It is the import's version of `cf deploy --no-provision`: a run that is meant
to update an organization can't quietly add a second copy of something.

## Rules

- People invited because a reference chose "invite" are not blocked: that
  invitation is itself an answer given in the review.
- The choice belongs to one request. It is not carried to later imports.
- API only for now: the review screen has no control for it.

## How to try it

Turn it on for one organization in `/admin`. Upload an export that holds an
item the organization lacks, `PUT` the decisions with `createMissing: false`,
and read the plan: the item is blocked, and the request can't be approved
until it is matched or skipped.

## Turning it off

A `PUT` with `createMissing: false` answers 404 `feature_disabled`. Requests
that already hold the choice keep it until their decisions are sent again.

## What to watch

Requests that stay in review with only `blocked` items.
