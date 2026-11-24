# Node runtime security baseline

Standalone OpenWork Node runtimes use **Node 24.22.1** as the October 21, 2026 security baseline. Package engines accept stable patched Node 24 releases (`>=24.22.1 <25`); another major requires explicit compatibility and security review.

Sources: [Node security announcement](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), [Node 24.22.1 release](https://nodejs.org/en/blog/release/v24.22.1/).

## What is pinned

- `.nvmrc`, CI standalone Node jobs, official Docker Node bases, sandbox defaults, and downloaded private runtimes use 24.22.1.
- Official tarball downloads retain SHA-256 verification. Immutable Docker image references retain verified digests.
- Native Render and Vercel application package manifests declare the bounded Node 24 engine range.
- Bootstrap and standalone npm server launchers reject unsupported runtimes. The installer can install a private supported Node without replacing system Node.
- Standalone Undici packages and overrides use 6.29.1 / 7.30.1. Node's bundled Undici and separately installed Undici are different copies.

TypeScript/esbuild compilation targets describe output compatibility, not the Node runtime installed on the host. Third-party package engine requirements and historical benchmark runtime records are not deployment runtime pins.

## Deployment checklist

A source change alone does not patch an existing process, image, or VM snapshot.

1. Build and test on the approved Node version, including native dependencies.
2. Publish new application images. Refresh approved immutable application image digests in deployment releases; do not retag old images and assume they are patched.
3. Rebuild computer and worker snapshots, promote their configuration pins, and replace affected instances through the normal lifecycle.
4. Roll out services and jobs. Verify the actual runtime in every relevant application image/process:

   ```sh
   node -p 'JSON.stringify({node: process.version, undici: process.versions.undici, arch: process.arch})'
   ```

5. Recheck service health, provider/MCP connections, streaming, and worker startup. Configuration readback alone is not runtime proof.

### Render

For native Node services, merge `NODE_VERSION=24.22.1` into existing environment variables. Never replace the entire environment just to set the runtime. Check environment-group overrides, service settings, build logs, and the deployed process version. Include maintenance cron jobs and explicitly review suspended services before reactivating them.

For Docker services, the Dockerfile/application image selects Node; `NODE_VERSION` in the service environment does not replace the image's executable. Rebuild and redeploy the application image.

Environment updates and repository changes must not be reported as a verified rollout until deployment and runtime checks complete.

### Vercel

Use project Node.js setting **24.x** and the app-root package engine range `>=24.22.1 <25`. Vercel manages the patch version; these settings do not by themselves prove a particular deployed patch. Check the new deployment's build logs/runtime and the provider's security rollout before declaring it remediated. Existing deployments still require verification.

### Helm

The chart selects **OpenWork application release images**, not standalone Node images. Keep `Chart.appVersion` and component/global image tags as OpenWork versions; never replace them with `24.22.1`.

Deploy a newly built patched application release and run `helm test <release> --logs`. The existing env-probe hook reports the actual Den API image's Node runtime and rejects versions outside the patched Node 24 baseline. This hook does not independently verify Den Web, Gateway, existing replicas, or snapshots; check those images/processes separately. See `packaging/helm/openwork-ee/README.md`.

## Separate runtime tracks

Electron embeds its own Node runtime. Updating standalone Node, `.nvmrc`, or CI does not patch a packaged desktop application. Require an Electron release containing these Node fixes or verified upstream security backports, then rebuild and ship the desktop. Check the embedded `process.versions`, not the developer's shell Node. OpenCode's Bun-compiled sidecars are a separate runtime track as well.

## Regression checks

Run under Node 24.22.1; Helm must be installed for chart rendering:

```sh
pnpm test:node-runtime
pnpm --dir packages/openwork-bootstrap test
```

The image-publication workflow runs the source pin consistency checks and rendered Helm runtime-probe tests. These checks catch drift but do not prove a production deployment has been upgraded.
