/**
 * Internal asset check for the Daytona Windows enterprise certificate skill.
 *
 * This is intentionally app-less: it proves the checked-in skill, helper script,
 * and cleanup guidance are coherent locally without requiring Daytona or a
 * Windows sandbox.
 */
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "daytona-windows-cert-assets";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const exists = (path) => access(path).then(() => true, () => false);

function witness(ctx, condition, assertion, actual) {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, assertion + (actual ? ` (actual: ${actual})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function frontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  return match[1];
}

function frontmatterValue(body, key) {
  const pattern = new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|(.+))$`, "m");
  const match = body.match(pattern);
  if (!match) return "";
  return (match[1] ?? match[2] ?? match[3]).trim();
}

function snippetContaining(text, needles) {
  return text
    .split("\n")
    .filter((line) => needles.some((needle) => line.toLowerCase().includes(needle.toLowerCase())))
    .join("\n");
}

export default {
  id: FLOW_ID,
  title: "Daytona Windows enterprise certificate skill assets stay coherent",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Skill frontmatter and trigger keywords are registered",
      run: async (ctx) => {
        await ctx.prove("The daytona-windows-cert skill exists with valid trigger-rich frontmatter", {
          voiceover: vo[0],
          assert: async () => {
            const skillPath = join(ROOT, ".opencode", "skills", "daytona-windows-cert", "SKILL.md");
            witness(ctx, await exists(skillPath), ".opencode/skills/daytona-windows-cert/SKILL.md exists");
            const skill = await readFile(skillPath, "utf8");
            const meta = frontmatter(skill);
            witness(ctx, Boolean(meta), "Skill has YAML frontmatter");
            const name = meta ? frontmatterValue(meta, "name") : "";
            const description = meta ? frontmatterValue(meta, "description") : "";
            witness(ctx, name === "daytona-windows-cert", "Frontmatter name is daytona-windows-cert", name);
            const keywords = [
              "test on Windows",
              "enterprise CA",
              "corporate certificate",
              "GPO cert",
              "TLS fetch failed",
              "Windows sandbox",
              "daytona windows",
              "self-hosted cert",
            ];
            for (const keyword of keywords) {
              witness(ctx, description.toLowerCase().includes(keyword.toLowerCase()), `Description contains trigger keyword ${JSON.stringify(keyword)}`, description);
            }
            ctx.output("skill-frontmatter", `name: ${name}\ndescription: ${description}`);
          },
        });
      },
    },
    {
      name: "Skill reuses the checked-in support scripts",
      run: async (ctx) => {
        await ctx.prove("The runbook links to the real TLS repro and doctor scripts, and those files exist", {
          voiceover: vo[1],
          assert: async () => {
            const skillPath = join(ROOT, ".opencode", "skills", "daytona-windows-cert", "SKILL.md");
            const skill = await readFile(skillPath, "utf8");
            const scripts = [
              "scripts/support/setup-openwork-tls-repro.ps1",
              "scripts/support/openwork-doctor.ps1",
            ];
            for (const script of scripts) {
              witness(ctx, skill.includes(script), `Skill references ${script}`);
              witness(ctx, await exists(join(ROOT, script)), `${script} exists on disk`);
            }
            ctx.output("support-script-references", snippetContaining(skill, scripts));
          },
        });
      },
    },
    {
      name: "The reusable CA probe is syntax-valid and checks the system store",
      run: async (ctx) => {
        await ctx.prove("ca-probe.js exists, passes node --check, and calls tls.getCACertificates(\"system\")", {
          voiceover: vo[2],
          assert: async () => {
            const probePath = join(ROOT, ".opencode", "skills", "daytona-windows-cert", "scripts", "ca-probe.js");
            witness(ctx, await exists(probePath), ".opencode/skills/daytona-windows-cert/scripts/ca-probe.js exists");
            const probe = await readFile(probePath, "utf8");
            const check = spawnSync(process.execPath, ["--check", probePath], { encoding: "utf8" });
            witness(ctx, check.status === 0, "node --check passes for ca-probe.js", check.stderr.trim() || String(check.status));
            witness(ctx, probe.includes('tls.getCACertificates("system")'), "ca-probe.js calls tls.getCACertificates(\"system\")");
            ctx.output("ca-probe-evidence", `$ node --check ${probePath}\nstatus=${check.status}\n\n${snippetContaining(probe, ["getCACertificates", "reproInSystem", "reproInDefault"])}`);
          },
        });
      },
    },
    {
      name: "Cleanup guidance prevents leaked sandboxes, tasks, certs, and releases",
      run: async (ctx) => {
        await ctx.prove("The skill documents every cleanup command needed to tear down the repro", {
          voiceover: vo[3],
          assert: async () => {
            const skillPath = join(ROOT, ".opencode", "skills", "daytona-windows-cert", "SKILL.md");
            const skill = await readFile(skillPath, "utf8");
            const commands = [
              "schtasks /end /tn OpenWorkTlsRepro",
              "setup-openwork-tls-repro.ps1 -Cleanup",
              "daytona sandbox delete <ID>",
              "gh release delete <tag> --yes",
            ];
            for (const command of commands) {
              witness(ctx, skill.includes(command), `Cleanup command is documented: ${command}`);
            }
            ctx.output("cleanup-commands", snippetContaining(skill, commands));
          },
        });
      },
    },
  ],
};
