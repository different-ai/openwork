# Automations: every few hours

- Feature: `automationIntervalSchedules` — **retired (2026-10)**
- Deployments: cloud and self-hosted
- Owner: `benjaminshafii`

Generally available. An Automation can repeat every few hours (for example every
3 hours from 09:00 until 18:00 on weekdays) without a per-organization flag.

The flag was retired coherently across the API, scheduler, desktop UI, runtime
knowledge, contracts, tests and docs. Older desktop clients and stored
overrides that still send `automationIntervalSchedules` are accepted and
ignored; the response-only compatibility value stays `true`. Cloud placement,
the headless runner availability, Google Calendar scope and the
`automationTargetAllowed` (Desktop/Cloud) toggle remain enforced without a flag.

See `reports/ga-feature-retirement.md` for the retirement record.