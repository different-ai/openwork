# OpenWork Web per member

> **Generally available:** `webPerMember` is retired; its enabled behavior is standard on Cloud and self-hosted. Actual settings, permissions, billing rules and consent remain enforced. Rollout/off-state instructions below are historical; see [the retirement guide](../globally-enabled-retirement/README.md).

- Feature: `webPerMember`
- Deployments: cloud and self-hosted
- Author: reachjalil
- Default: off

## What changes

Today OpenWork Web is bought for the whole organization: every member and
pending invitation is billed for it and can use a Web computer.

With `webPerMember` on, an admin chooses who gets Web:

- **Members page.** A new *OpenWork Web* column has a switch on each member
  and pending invitation. A line above the list says how many people have Web.
  Changing a switch needs the **Manage billing** permission.
- **Billing.** The OpenWork Web subscription bills only the people with Web
  turned on. Each change updates the Stripe quantity right away, and the
  prorated amount goes on the next invoice. Team seats and OpenWork Models
  still bill every user.
- **Access.** A member without Web can't open a Web computer, run Automations
  on one, start remote sessions on OpenWork Cloud or open the Office editor in
  Cloud. web.openworklabs.com shows them "Ask an admin for OpenWork Web" in
  place of the purchase prompt.
- Everyone keeps Web until an admin turns it off: the stored value
  (`member.openwork_web`) defaults to on, including for new invitations.
- An admin can't turn off the last person with Web while the Web subscription
  is active, because Stripe can't bill zero people. To stop paying for Web,
  cancel it from Billing.

## How to try it

1. In `/admin`, turn on `webPerMember` for one organization that has Web.
2. As an owner or admin of that organization, open **Members** and turn Web off
   for one member.
3. That member's web.openworklabs.com shows "Ask an admin for OpenWork Web". In
   Stripe, the organization's Web subscription quantity drops by one.

API: `POST /v1/members/:memberId/openwork-web` with `{ "enabled": false }`.
`GET /v1/billing/web` adds `memberHasAccess` for the caller.

## Turning it off

Turning the feature off, or the kill switch, gives Web back to every member
right away. Stored choices are kept but ignored, so Web bills every user again
from the next quantity sync (any member change, or the hourly invitation-expiry
job). Turning it back on brings the stored choices back.

## What to watch

- den-api logs: `openwork web quantity sync failed after member change`.
- Stripe: the organization's Web subscription quantity should match the
  summary line on the Members page.
