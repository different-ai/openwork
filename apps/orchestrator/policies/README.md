# OpenShell policy bundle

This directory ships with OpenWork as the default set of OpenShell
sandbox policies. Each `*.yaml` file becomes selectable in the
**Settings → Sandbox** panel. The bundle is mapped into the packaged
Electron app at `process.resourcesPath/openshell-policies/` by
`electron-builder.yml` and copied into each sandbox at create-time.

Files:

| File | Use it when |
|---|---|
| `default.yaml` | You want the strictest possible default — no network, /workspace only. |
| `banking-strict.yaml` | Production banker workspaces. Allowlists LLM providers + your firm's internal endpoints. **This is the default OpenWork uses when no override is specified.** |
| `research-broad.yaml` | Analyst workspaces that need to fetch public research (arXiv, PubMed, SEC EDGAR, FRED, etc.). |
| `privacy-router.yaml` | PII redaction config layered alongside any of the policies above. |

## What the policy schema lets you control

OpenWork inherits the stock OpenShell policy schema (see
[NVIDIA/OpenShell-Community](https://github.com/NVIDIA/OpenShell-Community)
for the canonical spec). The shapes used in this bundle:

- **`filesystem_policy`** — `read_only[]` / `read_write[]` paths,
  enforced via Landlock. `/workspace` is the only place the agent can
  write by default. Adding extra read-write paths is a deliberate
  security regression — review carefully.
- **`landlock.compatibility: best_effort`** — kernels that don't
  support Landlock still run; the sandbox just leans harder on the
  network + capability layers.
- **`process.run_as_user`** — never `root`. The OpenShell base image
  bootstraps a `sandbox` user; keep it that way.
- **`process.deny_binaries[]`** — explicit binary denies. Layer-of-defense
  against bring-your-own-tool exfiltration. The bundled lists cover
  packet sniffers and kernel-module loaders.
- **`network_policies`** — named allowlists. Each entry has a `host`,
  `port`, optional `protocol` / `tls` / `enforcement` / `access`. The
  Privacy Router treats `tls: terminate` endpoints as in-scope for
  redaction.
- **`approval_required_hosts[]`** — hosts that surface as banker-
  confirmable approval prompts via OpenWork's existing approval flow.
- **`deny_egress[]`** — hard denies that override everything else.
  Use for ports/hosts you never want reachable regardless of policy.
- **`resources`** — CPU / memory / disk caps. Hard limits enforced by
  cgroups. Defaults are 2 vCPU / 4 GB / 10 GB — enough for the
  bundled agent layer and a reasonable workload.

## Authoring a custom policy (for bank IT)

1. Copy the policy closest to what you need:
   ```
   cp banking-strict.yaml my-firm.yaml
   ```
2. Replace the `REPLACE.*.internal.bank.invalid` placeholders in
   `network_policies.firm_internal.endpoints[]` with your real internal
   hosts.
3. Add any extra LLM provider hosts your firm uses (Azure OpenAI, AWS
   Bedrock, internal model proxies) as additional named
   `network_policies` entries.
4. Audit `deny_egress[]` for ports you specifically need to allow
   (rare in banking; usually you want it stricter than the default).
5. Drop the file into your SCCM/Intune deployment under
   `%LOCALAPPDATA%\openwork\openshell-policies\my-firm.yaml`.
6. Distribute a deployment profile that points OpenWork at it:
   ```
   {
     "sandbox": {
       "defaultPolicy": "my-firm.yaml"
     }
   }
   ```

## Validating a policy before shipping

OpenWork itself does not validate the OpenShell policy schema — the
`openshell sandbox create` call inside the WSL distro is authoritative.
To dry-run a policy without touching production:

```bash
wsl -d openwork-openshell -- openshell policy validate /mnt/c/path/to/my-firm.yaml
```

A non-zero exit means the policy is malformed; the stderr will name the
offending field.

## What's *not* covered

- **Outbound credentials.** OpenShell's provider-credential system
  injects API keys via the HTTP proxy. Don't put bearer tokens into
  policy YAML — they go in the OpenWork settings under Environment.
- **DNS resolution policy.** OpenShell uses the distro's `/etc/resolv.conf`
  by default. Override at the WSL level if you need split-horizon
  resolution.
- **Inbound traffic.** Sandboxes don't accept inbound connections.
  The `--port-forward` argument is host-only and bound to `127.0.0.1`.
