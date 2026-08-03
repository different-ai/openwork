# composable-release — one review ships an observable, resumable release

1. I launch a patch, minor, or major release from the CLI or GitHub UI. The release dashboard shows the target version and every independent stage.

2. OpenWork creates a signed release branch, bumps the versions, and stages immutable desktop artifacts. It calculates AUR checksums from those exact staged Linux files and adds the packaging update to the same signed release PR.

3. When checks pass, I review and approve that final PR once. GitHub auto-merges it, and no later stage asks me to check merge status, approve another PR, or rerun the whole release.

4. The merge continuation creates the tag once, publishes the already-staged desktop artifacts, and runs server and snapshot publication as separate retryable stages. The published files are the same files whose checksums I reviewed.

5. AUR publication consumes the merged packaging files and those immutable release assets directly. If AUR fails, I rerun only AUR publication without rebuilding desktop assets or changing checksums.

6. The orchestrator shows every stage as pending, waiting, passed, or failed, including inputs, outputs, workflow links, and exact retry commands. Completed stages stay immutable and failures remain local.
