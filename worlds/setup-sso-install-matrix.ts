import { hold } from "../packages/world/src/hold.ts";
import { output } from "../packages/world/src/outputs.ts";
import { bootSetupSsoInstallMatrix, setupSsoInstallMatrixManifestPath } from "../evals/worlds/setup-sso-install-matrix.ts";

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const matrix = await bootSetupSsoInstallMatrix(stack);
  const outputs: Record<string, ReturnType<typeof output>> = {
    manifest: output(setupSsoInstallMatrixManifestPath(), { group: "Proof" }),
    commit: output(matrix.commit, { group: "Proof" }),
    source_fingerprint: output(matrix.source.fingerprint, { group: "Proof" }),
    web_mode: output(matrix.source.webMode, { group: "Proof" }),
    dirty_product_files: output(JSON.stringify(matrix.source.dirtyProductFiles), { group: "Proof" }),
  };
  for (const column of matrix.columns) {
    const key = column.id.replaceAll(".", "_").replaceAll("-", "_");
    outputs[`${key}_web`] = output(column.webUrl, { group: column.id });
    outputs[`${key}_api`] = output(column.apiUrl, { group: column.id });
    outputs[`${key}_project`] = output(column.project, { group: column.id });
    outputs[`${key}_api_image`] = output(column.apiImage, { group: column.id });
    outputs[`${key}_api_version`] = output(column.apiVersion, { group: column.id });
    outputs[`${key}_web_image`] = output(column.webImage, { group: column.id });
  }
  if (matrix.pending) {
    outputs.pending_web = output(matrix.pending.webUrl, { group: matrix.pending.id });
    outputs.pending_api = output(matrix.pending.apiUrl, { group: matrix.pending.id });
    outputs.pending_project = output(matrix.pending.project, { group: matrix.pending.id });
  }
  await hold({ name: "setup-sso-install-matrix", outputs });
}

if (import.meta.main) await main();
