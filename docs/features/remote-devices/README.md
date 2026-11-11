# Computers in Den (`remoteDevices`)

- **Key:** `remoteDevices`
- **Deployments:** cloud and self-hosted
- **Default:** off
- **Author:** @benjaminshafii

## Where it lives

**Regular Den → Manage → Computers**, at `/dashboard/computers`, inside the
selected organization. This is a customer organization management page, not
OpenWork's internal `/admin` panel.

Organization owners and admins have **View computers** (`computers.view`) by
default. They see the team's reported computers across all members, with the
owner, type, status, last contact, version and supported inventory. They can
inspect reported adapters, permissions/readiness and runner capabilities
without impersonating a member. Registered OpenWork instances are included
from Den's existing worker inventory; the page never exposes their tokens,
provider reference blobs, endpoints or filesystem paths.

![Computers in regular Den](den-computers.png)

The misplaced platform-admin Devices page and tools originally introduced in
this PR have been removed. Existing, unrelated diagnostics are unchanged.

## Member views stay personal

Desktop **Settings → Devices** and Workbot **Devices** remain available.
They show only the member's own computers and computers registered as shared
with the organization. An organization admin's team-wide visibility in Den
does not make the admin's personal Desktop or Workbot list impersonate other
members.

![Settings → Devices on Desktop](desktop-devices.png)

![Devices in Workbot](workbot-devices.png)

## Sources and identity

`remote_device` has one row per organization, provider and provider identity.
It stores metadata, not provider credentials:

| Source | How it appears |
|---|---|
| Desktop | The signed-in app reports its stable install identity, versions and computer readiness on launch, on change and every five minutes. Den uses the same scoped runner identity as remote tasks. Older runner registrations are included even before they send a device report. |
| Workbot | The computer route reports viewer and lifecycle activity, or a fixed failure code. Each computer remains scoped to its actual conversation owner. |
| Configured VMs | A desktop configured to reach a Freestyle or Daytona computer reports the provider ID and observed readiness, never its key. |
| Registered VMs/Mac sandboxes | Members register metadata for themselves; sharing with the organization needs the existing Manage desktop policies permission. Registration makes no provider call. |
| Registered OpenWork instances | Den's existing organization-scoped worker/runtime inventory supplies instance metadata and last reported activity. No duplicate provider provisioning or access store. |

A desktop counts as online for ten minutes after its latest report or runner
contact. A stale virtual-computer report is **Not checked yet**, never an
assumed pause that Den did not observe. Reports and state are not independent
live provider health checks. Desktops unseen for 30 days leave the reported
computer list. Each device retains its latest 200 events for 30 days, with
fixed codes and bounded diagnostic metadata.

## Authorization

- Team-wide reads use the selected organization context and require both
  `remoteDevices` and `computers.view`, checked server-side.
- A device from another organization is not readable through the team detail
  route, even when its ID is known. Caller-supplied filter parameters cannot
  select a different organization's inventory.
- Ordinary members cannot read team-wide inventory. Their existing personal
  routes still return only owned/shared computers.
- A desktop cannot take over another member's entry or change a shared entry
  without permission. Workbot cannot report a forged conversation identity.
- Audit declarations cover tenant reads and reports without recording secrets,
  screen content or files. Owner and inventory metadata are visible to the
  organization's authorized administrators, not to arbitrary members.

## Not provisioning or an access broker

Adding a Freestyle VM or Mac sandbox names it in OpenWork. It does **not**
provision, start, stop or delete the machine, grant credentials, or make a
previously inaccessible computer controllable. Existing computer adapters,
runner authorization and remote-task transports remain authoritative. Nothing
here enumerates an external provider account or imports machines automatically
from a Mac host.

## Turning it off

Disable `remoteDevices` for the organization or use its kill switch. Computers
in Den and the member Devices views disappear, gated reads return
`404 feature_disabled`, and desktop reports stop on their next check. Stored
records remain. Existing computer use and remote tasks work as before.

## Verification

- `ee/apps/den-api/test/api/remote-devices.api.test.ts`: organization RBAC,
  all-member visibility, personal visibility, cross-organization isolation,
  report identity, shared-write restrictions, races and event retention.
- `evals/proofs/den-computers.proof.test.ts`: actual regular Den navigation and
  the organization-admin Computers page, including member restrictions.
- `evals/proofs/remote-devices-desktop.proof.test.ts` and
  `evals/proofs/remote-devices-workbot.proof.test.ts`: preserved personal views.

All live tests use disposable local databases. No production feature overrides
are part of this PR.
