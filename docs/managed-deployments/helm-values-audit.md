# Helm values audit

The checked-in `openwork-ee/values.yaml` has 278 leaf paths, counting
lists and empty maps as single leaves. The table classifies every leaf
under each prefix; generated preview keys are not counted separately.

| Paths | Leaves | Decision and reason |
| --- | ---: | --- |
| `nameOverride`, `fullnameOverride`, `image`, `imagePullSecrets` | 5 | Keep: resource names, image pin and registry access. |
| `headlessRunner`, `workbot` | 2 | Keep: opt-in workload maps for the chart-managed runner and Workbot, empty by default. Their keys are listed in `companions.md` and checked by `openwork-ee.companions.validate`. |
| `observability`, `customCa`, `redis`, `secret` | 75 | Keep: telemetry destinations, trust, transport and credential wiring. |
| `installerArtifacts`, `migrations`, `ingress`, `tests` | 26 | Keep: artifact storage, database bootstrap, networking and the opt-in `helm test` health request. |
| `denApi`, `denWeb` | 52 | Keep: Kubernetes workload settings, env overrides and maintenance jobs. |
| `gateway`, `inference` | 30 | Keep: Gateway infrastructure and legacy compatibility. |
| `config.databaseMode`, `config.openworkDevMode`, `config.denApiNodeOptions`, `config.deployment` | 4 | Keep: runtime and installation identity. |
| `config.features` | 1 | Keep for optional env locks only. Org preview opt-in uses Config Import or `/admin`; it is not an equivalent substitute for a deployment lock. |
| `config.administratorRecovery`, `config.tenancy` | 11 | Keep: bootstrap, recovery and install-wide signup and verification. Org Config cannot replace them. |
| `config.audit` | 3 | Keep: self-hosted entitlement and deployment-wide capture and visibility gates. `settings.audit.spec.captureOn` is the organization policy; its apply route checks the visibility gate, entitlement and capture availability. |
| `config.auth` | 2 | Keep: the password screening and API key creation defaults are runtime-wide. `settings.auth-security` covers session policy, SSO and SCIM, not these defaults. |
| `config.email`, `config.githubConnector` | 3 | Keep: invitation sender routing and instance GitHub App identity. Connector imports configure organization connections, not the app registration. |
| `config.public` | 23 | Keep: endpoints, trust, bootstrap admins, and capability or runtime switches. `settings.web-origins` does not configure Den's public origin, cookies, CORS or MCP resource identity. `settings.general` sets organization Desktop and Cloud Automations policy, not the deployment or legacy runtime switches. Dashboard, OpenWork Web, artifact view and app MCP server switches have no equivalent Org Config setting. |
| `config.internal`, `config.provisioner`, `config.daytona`, `config.inference`, `config.web` | 41 | Keep: service routing, worker provisioning and sandbox lifecycle, upstream and billing wiring, analytics. Org provider and access policies do not set these runtime inputs. |

No existing leaf can move to Org Config without dropping an installation-wide
control. Keep organization settings in the import file: audit capture policy,
workspace settings (including separate Desktop/Cloud Automations policy),
connectors, skills, teams and optional previews. Add a path to the chart's
`_deprecations.tpl` guard and cover an upgrade render before ever removing
an existing product value in favor of an equivalent import setting.

`headlessRunner` and `workbot` are separate, opt-in workload maps and belong in
Helm. With both off, an operator who runs the companions separately still
passes their addresses through `denApi.env`. Don't introduce parallel chart
switches for the Slack assistant or cloud computers: follow the
[capability catalog](settings-and-capabilities.md#the-catalog).
