# enterprise-installer-best-practices — one deterministic configuration model for enterprise deployment

1. An administrator prepares one organization JSON with the company server, sign-in policy, branding, and exact OpenWork version, then runs the repository’s enterprise installer command.

2. The command combines the unchanged signed generic installer, unchanged signed desktop release, and organization JSON into one auditable ZIP for self-service or air-gapped distribution.

3. Dry-run validates without changing local state, failed installation leaves the previous deployment intact, and a successful installation writes the canonical bootstrap atomically only after the application is in place.

4. Managed fleets use the same configuration model through Intune, Jamf, or another MDM: IT deploys the normal signed application and managed bootstrap directly, without a customer-specific executable or a deep-link installer.
