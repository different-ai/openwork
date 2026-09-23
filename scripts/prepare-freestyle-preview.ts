import { previewWorld } from "../packages/freestyle/src/index.ts";
import { ensureSnapshot } from "../packages/freestyle/src/builder.ts";

const sha = process.argv[2];
if (!sha) throw new Error("Usage: node --env-file=.env.freestyle.local scripts/prepare-freestyle-preview.ts <full-pushed-sha>");
const snapshot = await ensureSnapshot(sha, undefined, (message) => console.error(message), previewWorld(process.argv[3] ?? "app-web"));
console.log(JSON.stringify({ gitSha: sha, snapshotId: snapshot.id, slug: snapshot.slug }));
