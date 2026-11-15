# Config import: match plugins and skills by name

- Key: `configImportMatchByName`
- Deployments: cloud and self-hosted
- Author: benjaminshafii
- Default: off

## What changes

Importing a configuration file (Settings › Configuration, or the
`/v1/config-blobs` API) compares each item in the file with what the
organization already holds. People are recognised by email, teams and spend
limits by name. Plugins and skills were recognised only when an earlier
import of the same file had created them, so a plugin or skill that already
existed under the same name was planned as a second copy.

With the feature on, the plan treats these as the same item:

- a plugin the organization shares under the same name (built-in plugins
  were already matched this way);
- a skill, agent or command of the same type and title that is not managed
  by a source.

The plan then shows an update with the fields that differ, or "unchanged",
with the reason "matched by name" or "matched by type and title". The match
is made only when the name is used once in the file and once in the
organization; otherwise the item is listed with suggestions and the admin
chooses. An admin can still choose "create" for a matched item in the review.

## Not part of the feature (always on)

A plugin create that would fail on "You already have an active plugin named
…" is blocked in the plan, before approval, with what to do about it. Two
plugins of one name created by the same import are flagged the same way.

## How to try it

Turn it on for one organization in `/admin`, create a shared skill, export
the organization, and import the file into another organization that shares
a skill of the same title: the plan lists it as an update or unchanged.

## Turning it off

Plans made afterwards go back to proposing a new item. Plans already
approved are applied as approved; a plan that is opened again is rebuilt and
may change, in which case it asks for approval again. Nothing stored depends
on the feature.

## What to watch

`config_change_request` rows that end `failed` with `duplicate_plugin`, and
plans with unexpected `update` items on plugins or skills.
