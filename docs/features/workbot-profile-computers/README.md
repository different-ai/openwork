# Workbot: Computers in its profile

- Generally available on Cloud and self-hosted (retired rollout: `workbotProfileComputers`)
- Owner: `benjaminshafii`

Workbot's profile contains the **Computers** tab, using the same monitor-and-device icon, selected state and arrow-key navigation as the other tabs. The centered profile has six equal-width tabs; phone and desktop use the same list.

The list is the existing member-scoped `WorkbotDevices`: loading, empty, retry, last-known data, availability and guarded Open actions are unchanged. Opening a Workbot computer closes the sheet and invokes the same chat/draft checks as the Devices page. No machine is provisioned by opening this tab. Existing `/devices` links still work.

## Try it

In a test organization with Workbot and remote access configured, open Workbot's profile, select Computers, and inspect the existing inventory. Check desktop and narrow phone widths, arrow keys, Home/End and Escape.

Workbot and computer access rules still apply. Watch for duplicate navigation, overflow and failed inventory reads.

## UI evidence

Real Workbot React UI with deterministic fixture API responses (not live Den/runner integration):

![Before: five-tab profile with the standalone Devices entry](before-profile.png)

![Desktop profile with Computers selected](desktop-computers.png)

![Phone profile with Computers selected](phone-computers.png)

![Narrow 320px phone profile with Computers selected](phone-320-computers.png)

See [verification](verification.md) for test commands, the clean-base control and limitations.
