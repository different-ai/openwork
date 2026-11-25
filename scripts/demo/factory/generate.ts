import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { load, makePlan, selectedBeats } from "./compile.ts";
import type { Composition } from "./compile.ts";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function block(value: string, language = "") {
  const runs = value.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}${language}\n${value}\n${fence}`;
}
const bullets = (values: string[]) => values.length ? values.map((v) => `- ${v}`).join("\n") : "None.";

export function renderScript(c: Composition, optional = false) {
  const plan = makePlan(c, optional);
  const beats = selectedBeats(c, optional);
  const sections = [
    `# ${c.demo.title}`,
    "> REHEARSAL SPECIFICATION — live proof pending. Generated offline; no actions have run. Grounded means authored/source-grounded, not live-verified. Draft optional beats must be skipped until separately proven.",
    `## Start state — verify before presenting\n\n${block(json(plan.ready).trim(), "json")}`,
    `## Surfaces\n\n${bullets(c.demo.desktops.map((d) => `**${d.id}**: ${d.surfaces.join(", ")}`))}`,
    `## Audience and global boundaries\n\nAudience: ${plan.audience_roles.join(", ") || "not specified"}.\n\n${bullets(plan.avoid)}`,
    `## Sequence\n\n${beats.map((b, i) => `${i + 1}. [${b.title}](#${b.id})${c.demo.optional.includes(b.id) ? " — OPTIONAL" : ""}${b.status === "draft" ? " — DRAFT / PENDING LIVE PROOF" : ""}`).join("\n")}`,
  ];
  for (const b of beats) {
    sections.push([
      `<a id="${b.id}"></a>\n\n## ${b.title}`,
      `**${b.label} · ${b.status} · ${b.surface} / ${c.desktopFor.get(b.surface)} · ~${b.expect_seconds}s**${c.demo.optional.includes(b.id) ? " · OPTIONAL" : ""}`,
      ...(b.status === "draft" ? ["> DRAFT — pending live proof; not an approved live claim."] : []),
      `**Requires:** ${b.requires.join(", ") || "none"}. **Provides:** ${b.provides.join(", ") || "none"}.`,
      `### DO\n\n${block(json(b.do).trim(), "json")}`,
      `### SAY\n\n${b.say}`,
      `### PASTE\n\n${Object.entries(b.paste).map(([key, value]) => `**${key}**\n\n${block(value)}`).join("\n\n") || "None."}`,
      `### SEE\n\n${b.see}`,
      `### Verify\n\n${block(json(b.checks).trim(), "json")}`,
      `### Fallback\n\n${b.fallback}`,
      `### Avoid\n\n${bullets(b.avoid)}`,
      `### Q&A\n\n${b.questions.map((q) => {
        if ("answer" in q) return `- **${q.question}** ${q.answer}`;
        const target = beats.find((candidate) => candidate.id === q.beat);
        return `- **${q.question}** ${target ? `[${target.title}](#${q.beat}) — re-check prerequisites before taking this branch.` : `Library beat \`${q.beat}\` is not selected. Compose and validate it before use; do not jump there live.`}`;
      }).join("\n") || "None."}`,
      `### Reset\n\n${bullets(b.reset)}`,
    ].join("\n\n"));
  }
  sections.push(`## Reset checklist — reverse sequence\n\n${plan.reset.map((r) => `### ${r.beat}\n\n${bullets(r.instructions)}`).join("\n\n")}`);
  return `${sections.join("\n\n")}\n`;
}

export function generateArtifacts(c: Composition, optional = false) {
  const plan = makePlan(c, optional);
  return {
    "script.md": renderScript(c, optional),
    "prompts.json": json(plan.prompts),
    "plan.json": json(plan),
  };
}

export function main(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    demo: { type: "string", default: join(import.meta.dirname, "demos/acme-default.yaml") },
    personalization: { type: "string" },
    out: { type: "string" },
    "include-optional": { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("node scripts/demo/factory/generate.ts [--demo file.yaml] [--personalization file.yaml] [--out directory] [--include-optional] [--check]");
    return;
  }
  const c = load(values.demo, values.personalization);
  const artifacts = generateArtifacts(c, values["include-optional"]);
  if (values.check) {
    console.log(`Valid: ${c.demo.id}; ${c.main.length} main, ${c.optional.length} independent optional beats. Live proof pending; no actions executed.`);
    return;
  }
  const out = resolve(values.out ?? join(import.meta.dirname, "generated", c.demo.id));
  // Do not let an output path replace either caller-supplied input.
  const inputs = [values.demo, values.personalization].filter((p) => p !== undefined).map((p) => resolve(p));
  for (const name of Object.keys(artifacts)) if (inputs.includes(join(out, name))) throw new Error("Output would overwrite an input file");
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(artifacts)) writeFileSync(join(out, name), content);
  console.log(`Generated ${Object.keys(artifacts).join(", ")} in ${out}. Live proof pending; no actions executed.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
