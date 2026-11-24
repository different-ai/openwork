# Managed Google Cloud deployments

`managedGoogleCloudDeployments` · OpenWork Cloud only · default off · owner: @benjaminshafii

Enable this feature for the organization in `/admin` → Organizations → Features, not for everyone. It requires the existing **Managed deployments** feature and a separately qualified, configured Google Cloud installer release. Enabling the flag alone does not make an unconfigured installer available. It controls an organization-owned installation, not an individual member's access; the normal deployment permissions still apply. A member override does not approve a Google Cloud rollout.

In a test organization, open **Managed deployments** and compare Google Cloud readiness before and after enablement. Before enablement the provider explains that it is disabled for the workspace. After enablement it reports whether the installer release is ready. With a release configured, an authorized manager can save a target and prepare the Cloud Shell approval command; preparing the command does not run it.

Turning it off blocks new Google Cloud targets, installer handoffs (including reopening an outstanding approval), and enrollment of an installer that hasn't enrolled yet. It does not delete records, undo resources already created in Google Cloud, or interrupt enrolled progress events and signed health reports. Check `GET /v1/managed-deployments/configuration` for `feature_disabled` vs. release readiness, and the deployment list for progress and health. AWS is unchanged.

See [Managed deployments](../../managed-deployments.md) for the release and installation process.
