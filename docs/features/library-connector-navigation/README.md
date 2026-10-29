# Library connector navigation and skill previews

- Feature: `libraryConnectorNavigation`
- Deployments: Cloud and self-hosted
- Author: `benjaminshafii`
- Default: off

## What changes

Manage Connectors and My Library link to each other for the same connector:

- **Manage → My Library** appears only when the viewer can use the connector
  (it is in their usable list). Managing a connector is not a grant to use it.
- **My Library → Manage** appears only for people who can open Manage ›
  Connectors (`connections.view`). Members manage what they added from My
  Library itself (Share, Remove) and never see a link to a page they cannot open.

On the management page, **Sign out of your account** (or **Remove your key**)
uses the existing caller-scoped disconnect, separate from **Sign everyone out**.
Once signed out, the page no longer lists the tools the person could use before;
it says they show up after signing in.

Skills expand inline in plugin pages and My Library. My Library shows the skill
count (**2 skills**) when the summary knows it. A plugin that is a single skill
opens straight to **Steps**, without listing itself again. Steps longer than
eight lines open with **Show all steps**. Library previews load the existing
authorized plugin query only when expanded; skill source is shown as text.

## Try it

Enable `libraryConnectorNavigation` for a test organization in `/admin`.

As an admin: open an assigned connector in Manage, choose **Open in My
Library**, then **Manage** from its menu to go back. Sign in to a per-person
connector, then use **Sign out of your account**; teammates stay signed in.
An unassigned connector offers no Library link.

As a member: open a connector you added in My Library. Share and Remove are
there; **Manage** is not.

In My Library, expand a plugin's skill count, then a skill. Expand a one-skill
plugin's **Steps** and use **Show all steps**. Check keyboard disclosure,
narrow windows, and a failed preview with **Try again**.

## Turning it off

Disabling the feature restores the previous navigation and static skill rows.
No grants, published versions, connector setup, or signed-in accounts change.
Existing member connector pages and personal sign-out remain available.

## Evidence

Assigned connector, with personal sign-out separate from organization sign-out:

![Assigned connector Library link and personal sign-out](connector-actions.png)

Published skill steps expanded in the Library plugin detail:

![Expanded skill steps in a Library plugin](plugin-skill-steps.png)

My Library: a one-skill plugin opens to its steps with **Show all steps**, and a
plugin shows its skill count:

![One-skill steps and a skill count in My Library](library-skills.png)

`evals/proofs/library-connector-navigation.proof.test.ts` exercises the real Den
pages with assigned and unassigned connectors and published skill steps.
