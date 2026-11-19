import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** One fresh production build per proof worker, only if a review world is opened. */
export function reviewBuildGate(build: () => void) {
  let built = false;
  return (enabled: boolean) => {
    if (!enabled || built) return;
    build();
    // A failed build must never authorize next start to serve stale output.
    built = true;
  };
}

const build = reviewBuildGate(() => {
  const result = spawnSync("pnpm", ["--filter", "@openwork/review-app", "build"], {
    cwd: root,
    stdio: "inherit",
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Production review build failed (${result.signal ?? result.status}).`);
  }
});

export function prepareReviewBuild() {
  // Ordinary local runs still use their explicitly prepared app. Only the
  // secret-free normal PR proof lane opts into on-demand preparation.
  build(process.env.OPENWORK_EVAL_BUILD_REVIEW_APP === "1");
}
