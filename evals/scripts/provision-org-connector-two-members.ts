import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  deleteSandboxes,
  parseConnectorSpecEnv,
  provisionDenSandbox,
  provisionDesktopSandbox,
  renderConnectorSpecEnv,
  startMockOnSandbox,
} from "@openwork/hosts";
import type { DesktopSandbox } from "@openwork/hosts";

const USAGE = `Usage:
  node scripts/provision-org-connector-two-members.ts --ref <branch-or-commit> [--reuse-a <id>] [--reuse-b <id>] [--reuse-den <id>] [--out org-connector-two-members.env]
  node scripts/provision-org-connector-two-members.ts --delete <envfile>
  node scripts/provision-org-connector-two-members.ts --help`;

function prefixed(prefix: string, observe?: (line: string) => void): (line: string) => void {
  return (line) => {
    observe?.(line);
    console.error(`[${prefix}] ${line}`);
  };
}

async function deleteProvisioned(envFile: string): Promise<void> {
  const facts = parseConnectorSpecEnv(await readFile(envFile, "utf8"));
  await deleteSandboxes(facts.created);
  const created = new Set(facts.created);
  const leftAlone = [facts.sandboxA, facts.sandboxB].filter((sandbox) => !created.has(sandbox));
  console.log(`Deleted: ${facts.created.join(", ") || "(none)"}`);
  console.log(`Left alone: ${leftAlone.join(", ") || "(none recorded)"}`);
}

async function provisionSpecEnv(options: {
  ref: string;
  reuseA?: string;
  reuseB?: string;
  reuseDen?: string;
  out: string;
}): Promise<void> {
  const created: string[] = [];
  function recordCreated(sandbox: string): void {
    if (!created.includes(sandbox)) created.push(sandbox);
  }
  try {
    const denLog = prefixed("den", (line) => {
      const match = /Creating server sandbox:\s*(\S+)/.exec(line);
      if (match?.[1]) recordCreated(match[1]);
    });
    const den = await provisionDenSandbox({ ref: options.ref, reuse: options.reuseDen, log: denLog });
    if (den.created) recordCreated(den.sandbox);

    const mock = await startMockOnSandbox({ sandbox: den.sandbox, log: prefixed("mock") });
    async function desktop(name: "a" | "b", reuse: string | undefined): Promise<DesktopSandbox> {
      const desktopLog = prefixed(name, (line) => {
        const match = /desktop sandbox created:\s*(\S+)/.exec(line);
        if (match?.[1]) recordCreated(match[1]);
      });
      const result = await provisionDesktopSandbox({ ref: options.ref, name, reuse, log: desktopLog });
      if (result.created) recordCreated(result.sandbox);
      return result;
    }
    const [desktopA, desktopB] = await Promise.all([
      desktop("a", options.reuseA),
      desktop("b", options.reuseB),
    ]);

    await writeFile(options.out, renderConnectorSpecEnv({
      denApiUrl: den.apiUrl,
      denWebUrl: den.webUrl,
      sandboxA: desktopA.sandbox,
      sandboxB: desktopB.sandbox,
      mockUrl: mock.url,
      ref: options.ref,
      created,
    }), "utf8");

    console.log(`Wrote ${resolve(options.out)}`);
    console.log(`set -a; source ${options.out}; set +a`);
    console.log("pnpm --dir evals exec vitest run --config vitest.config.ts --project stack specs/org-connector-two-members.slow.test.ts");
    console.log(`node scripts/provision-org-connector-two-members.ts --delete ${options.out}`);
  } catch (error) {
    console.error(`Provisioning failed. Provision-created sandboxes so far: ${created.join(", ") || "(none)"}`);
    throw error;
  }
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ref: { type: "string" },
      "reuse-a": { type: "string" },
      "reuse-b": { type: "string" },
      "reuse-den": { type: "string" },
      out: { type: "string" },
      delete: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.delete) {
    await deleteProvisioned(values.delete);
    return;
  }
  if (!values.ref) throw new Error(`--ref is required.\n\n${USAGE}`);
  await provisionSpecEnv({
    ref: values.ref,
    reuseA: values["reuse-a"],
    reuseB: values["reuse-b"],
    reuseDen: values["reuse-den"],
    out: values.out ?? "org-connector-two-members.env",
  });
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
