# micx-models-hidden-single-org-dashboard — Self-hosted dashboard hides Micx Models

Runs against the local single-org Den stack (the self-hosted deployment shape):
den-api plus the den-web dashboard on port 3005, seeded with the Acme Robotics
demo organization.

1. Alex signs in to the self-hosted Micx dashboard. The runtime config reports single-org mode — this is a self-hosted deployment, not Micx Cloud.

2. Alex opens the Models section in the sidebar. It goes straight to LLM Providers, and there is no Micx Models entry anywhere in the navigation.

3. Even typing the old Micx Models address directly bounces Alex to LLM Providers — the hosted-only subscribe page simply does not exist on a self-hosted deployment.
