# @openwork/ui

Shared UI primitives for OpenWork apps.

This package intentionally ships two framework-specific entrypoints:

- `@openwork/ui/react` for React apps like `ee/apps/den-web`
- `@openwork/ui/solid` for Solid apps like `apps/app`

The public API should stay aligned across both entrypoints. If you add a new component, add both implementations in the same task unless there is a documented blocker.

## Paper components

The first shared components live under the `paper` namespace and wrap Paper Design shaders with OpenWork-specific defaults and deterministic seed support.

Current components:

- `PaperMeshGradient`
- `PaperGrainGradient`

Both accept a `seed` prop. Pass a TypeID-like string such as `om_01kmhbscaze02vp04ykqa4tcsb` and the component will deterministically derive colors and shader params from it. The same seed always produces the same result.

Explicit props still work and override the seeded values, so the merge order is:

1. OpenWork defaults
2. Seed-derived values from `seed`
3. Explicit props passed by the caller

## Layout convention

These components default to `fill={true}`, which means they render at `width: 100%` and `height: 100%`. Put them inside a sized container and they will fill it without needing manual width or height props.

## Agent notes

- Shared seed logic lives in `src/common/paper.ts`
- React wrappers live in `src/react/paper/*`
- Solid wrappers live in `src/solid/paper/*`
- Keep the framework prop names aligned unless there is a hard runtime mismatch
- Prefer extending the existing seed helpers instead of inventing per-app one-off shader configs
