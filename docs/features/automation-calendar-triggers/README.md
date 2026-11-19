# Automations: before or after meetings

- Feature: `automationCalendarTriggers` — **retired (2026-10)**
- Deployments: cloud and self-hosted
- Owner: `benjaminshafii`

Generally available. A Cloud Automation can run a set time before or after each
meeting on its owner's primary Google Calendar (for example 5 minutes after
every meeting with people outside the organization) without a per-organization
flag.

The flag was retired coherently across the API, scheduler, desktop UI, runtime
knowledge, contracts, tests and docs. Older desktop clients and stored
overrides that still send `automationCalendarTriggers` are accepted and
ignored; the response-only compatibility value stays `true`. Calendar triggers
remain Cloud-only, need Google Calendar with calendar scope, a headless runner /
OpenWork Cloud Automation available, and the `automationTargetAllowed` (Desktop/
Cloud) toggle stays on. Den still reads each owner's calendar at most every few
minutes only for owners with an active calendar-triggered Automation.

See `reports/ga-feature-retirement.md` for the retirement record.