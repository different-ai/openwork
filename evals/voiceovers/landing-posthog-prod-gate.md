# landing-posthog-prod-gate — Analytics ship in production only

The landing site promises anonymous, production-only analytics. This demo proves the gate from both sides.

1. On a local dev build there is no PostHog at all — no script, no global — and the hero prompt still copies cleanly, Copied state and all.

2. On the production build the PostHog snippet is present and initialized, so the same interactions are actually counted in the real world.
