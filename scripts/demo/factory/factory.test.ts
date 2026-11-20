import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compile, load, makePlan, readYaml } from "./compile.ts";
import { generateArtifacts } from "./generate.ts";
import { beat, demo, parseYaml, plan } from "./schema.ts";

const root = import.meta.dirname;
const manifest = join(root, "demos/acme-default.yaml");
const library = () => readdirSync(join(root, "beats")).filter((f) => f.endsWith(".yaml")).map((f) => beat.parse(readYaml(join(root, "beats", f))));
const sample = () => demo.parse(readYaml(manifest));
function fixture() {
  const first = beat.parse({
    id: "start", title: "Start", surface: "desktop", label: "MOCKED", status: "grounded",
    requires: [], provides: ["started"],
    do: [{ type: "ask", turn: "report", prompt: "report-prompt", model: "sample-model", same_thread: false }],
    say: "Fictional sample", paste: { "report-prompt": "Build a fictional report. Read only." }, see: "Task started",
    checks: [], reset: ["Remove this trial only"], fallback: "Skip", expect_seconds: 10, questions: [], avoid: [],
  });
  const last = beat.parse({
    ...first, id: "show", title: "Show", requires: ["started"], provides: [], paste: {},
    do: [{ type: "return_to_chat", turn: "report" }, { type: "wait_turn", turn: "report", timeout_seconds: 30 }, { type: "show", turn: "report", seconds: 5 }],
    checks: [{ type: "turn_succeeded", turn: "report" }],
  });
  const d = demo.parse({
    id: "fixture", title: "Fictional fixture", variables: {}, beats: ["start", "show"], optional: [],
    desktops: [{ id: "fixture-desktop", surfaces: ["desktop"] }],
    start_state: { auth: [], retained: { chats: [], files: [], artifacts: [], automations: [] }, facts: {} },
  });
  return { d, first, last };
}

test("all authored YAML parses; sample compiles to a strict plan", () => {
  const c = load(manifest);
  assert.equal(c.main.length, 8);
  assert.equal(c.optional.length, 5);
  const p = plan.parse(makePlan(c));
  assert.equal(p.mode, "declarative-only");
  assert.equal(p.live_proof, "pending");
  assert(p.steps.every((step) => !step.optional && step.status === "grounded"));
  assert(!JSON.stringify(p.ready).includes("PENDING LIVE PROOF"));
});

test("Workbot, Slack, and Cloud Automation are distinct optional drafts pending live proof", () => {
  const c = load(manifest);
  const p = makePlan(c, true);
  for (const [id, surface] of [["workbot_chat", "workbot"], ["workbot_in_sample_slack", "slack"], ["cloud_automation_run", "desktop"]]) {
    const step = p.steps.find((s) => s.id === id);
    assert(step);
    assert.equal(step.status, "draft");
    assert.equal(step.optional, true);
    assert.equal(step.surface, surface);
    assert(step.requires.every((fact) => c.demo.start_state.facts[fact]?.startsWith("PENDING LIVE PROOF")));
  }
  assert(!JSON.stringify(makePlan(c)).includes('"id":"workbot_chat"'));
});

test("start and show may be separated by other beats", () => {
  const c = load(manifest);
  const ids = c.main.map((b) => b.id);
  assert(ids.indexOf("report_spreadsheet") > ids.indexOf("start_report") + 1);
  assert.equal(compile(fixture().d, [fixture().first, fixture().last]).main.length, 2);
});

test("personalization applies consistently without mutating inputs", () => {
  const d = sample();
  const before = structuredClone(d);
  const c = compile(d, library(), {
    display_name: "Fictional Widget Lab", personas: { employee: "Sample Analyst" }, industry: "fictional manufacturing",
    audience_roles: ["Sample operations lead"], avoid: ["No outside writes"], variables: { report_file: "fictional.xlsx" },
  });
  assert.deepEqual(d, before);
  assert(c.demo.title.startsWith("Fictional Widget Lab"));
  assert(c.main[0]?.say.includes("Sample Analyst"));
  const p = makePlan(c);
  assert(p.prompts["report-prompt"]?.includes("fictional.xlsx"));
  assert.deepEqual(p.audience_roles, ["Sample operations lead"]);
  assert.deepEqual(p.avoid, ["No outside writes"]);
});

test("generators are deterministic and agree on prompts, order and Q&A", () => {
  const c = load(manifest);
  const output = generateArtifacts(c, true);
  assert.deepEqual(output, generateArtifacts(load(manifest), true));
  const p = plan.parse(JSON.parse(output["plan.json"]));
  assert.deepEqual(JSON.parse(output["prompts.json"]), p.prompts);
  assert.deepEqual(p.steps.map((b) => b.id), [...c.main, ...c.optional].map((b) => b.id));
  for (const heading of ["DO", "SAY", "PASTE", "SEE", "Q&A"]) assert(output["script.md"].includes(`### ${heading}`));
  assert(output["script.md"].includes("DRAFT — pending live proof"));
  assert(output["script.md"].includes("Library beat `build_artifact_by_prompt` is not selected"));
  assert(output["script.md"].includes("(#report_spreadsheet)"));
  assert.equal(p.reset[0]?.beat, "admin_teams_models_connectors");
  assert(!output["script.md"].includes("{{"));
});

test("paste fences cannot be closed by personalized backticks", () => {
  const { d, first, last } = fixture();
  first.paste["report-prompt"] = "```\nfictional\n```";
  assert(generateArtifacts(compile(d, [first, last]))["script.md"].includes("````\n```\nfictional\n```\n````"));
});

test("unknown personalization variables and unresolved/nested placeholders fail closed", () => {
  assert.throws(() => compile(sample(), library(), { variables: { surprise: "value" } }), /Unknown personalization override/);
  const d = sample();
  d.title = "{{unknown}}";
  assert.throws(() => compile(d, library()), /unknown variable unknown/);
  d.title = "{{ display-name }}";
  assert.throws(() => compile(d, library()), /malformed or nested/);
  assert.throws(() => compile(sample(), library(), { display_name: "{{employee}}" }), /malformed or nested/);
});

test("strict schema rejects typo keys, unsupported actions, paths, and invalid timeouts", () => {
  const { d, first, last } = fixture();
  assert.throws(() => compile({ ...d, beat: [] }, [first, last]), /unrecognized_keys/);
  assert.throws(() => compile(d, [{ ...first, do: [{ type: "shell", command: "anything" }] }, last]));
  for (const glob of ["/outside.xlsx", "../outside.xlsx", "a/../b.xlsx", "a\\b.xlsx"]) {
    assert.throws(() => beat.parse({ ...last, checks: [{ type: "file_created", turn: "report", glob }] }), /workspace-relative/);
  }
  assert.throws(() => beat.parse({ ...last, do: [{ type: "wait_turn", turn: "report", timeout_seconds: 0 }] }));
  assert.throws(() => beat.parse({ ...last, do: [{ type: "admin_goto", path: "https://fixture.example.test/" }] }));
});

test("all Q&A library references are validated even on unused beats", () => {
  const { d, first, last } = fixture();
  const extra = { ...last, id: "unused", questions: [{ question: "Next?", beat: "missing" }] };
  assert.throws(() => compile(d, [first, last, extra]), /unknown Q&A beat missing/);
});

test("duplicate IDs, selected refs, paste names, surfaces and auth assignments fail", () => {
  const { d, first, last } = fixture();
  assert.throws(() => compile(d, [first, first, last]), /Duplicate beat ID/);
  assert.throws(() => compile({ ...d, optional: ["show"] }, [first, last]), /Duplicate demo beat reference/);
  assert.throws(() => compile(d, [first, { ...last, paste: first.paste }]), /duplicate paste name/);
  assert.throws(() => compile({ ...d, desktops: [...d.desktops, ...d.desktops] }, [first, last]), /Duplicate desktop ID/);
  assert.throws(() => compile({ ...d, desktops: [...d.desktops, { id: "other", surfaces: ["desktop"] }] }, [first, last]), /Duplicate desktop surface/);
  const auth = { surface: "desktop", persona: "Sample", state: "signed_out" };
  assert.throws(() => compile({ ...d, start_state: { ...d.start_state, auth: [auth, auth] } }, [first, last]), /Duplicate start-state auth/);
});

test("unknown beat and unassigned beat/auth surfaces fail", () => {
  const { d, first, last } = fixture();
  assert.throws(() => compile({ ...d, beats: ["missing"] }, [first, last]), /Unknown beat missing/);
  assert.throws(() => compile(d, [{ ...first, surface: "slack" }, last]), /no desktop for slack/);
  assert.throws(() => compile({ ...d, start_state: { ...d.start_state, auth: [{ surface: "admin", persona: "Sample", state: "signed_in" }] } }, [first, last]), /No desktop for auth/);
});

test("prerequisites must exist before the beat; providers cannot overwrite facts", () => {
  const { d, first, last } = fixture();
  assert.throws(() => compile({ ...d, beats: ["show", "start"] }, [first, last]), /missing prerequisite started/);
  assert.throws(() => compile(d, [first, { ...last, provides: ["started"] }]), /already provided/);
  assert.throws(() => compile(d, [{ ...first, requires: ["ready", "ready"] }, last]), /Duplicate start prerequisite/);
});

test("draft beats cannot enter main", () => {
  const { d, first, last } = fixture();
  assert.throws(() => compile(d, [{ ...first, status: "draft" }, last]), /draft beats must be optional/);
});

test("optional beats must not depend on one another", () => {
  const { d, first, last } = fixture();
  const a = { ...last, id: "optional_a", provides: ["optional_fact"] };
  const b = { ...last, id: "optional_b", requires: ["optional_fact"] };
  assert.throws(() => compile({ ...d, optional: [a.id, b.id] }, [first, last, a, b]), /optional_b: missing prerequisite optional_fact/);
});

test("ask and sign-in must reference their own paste values; secret refs never become paste values", () => {
  const { d, first, last } = fixture();
  assert.throws(() => compile(d, [{ ...first, paste: {} }, last]), /missing paste value report-prompt/);
  const signIn = { ...first, do: [{ type: "sign_in", email: "employee-email", secret_ref: "password-handle" }], paste: {} };
  assert.throws(() => compile(d, [signIn, last]), /missing paste value employee-email/);
  const signedIn = { ...signIn, paste: { "employee-email": "sample@example.test" } };
  const showOnly = { ...last, do: [{ type: "show", seconds: 1 }], checks: [], paste: { "password-handle": "not-allowed" } };
  assert.throws(() => compile(d, [signedIn, showOnly]), /secret ref password-handle cannot be a paste value/);
});

test("turns cannot be duplicated, referenced before start, or moved between surfaces", () => {
  const { d, first, last } = fixture();
  assert.throws(() => compile(d, [first, { ...last, do: first.do, paste: { "another-prompt": "test" } }]), /missing paste value/);
  assert.throws(() => compile(d, [first, { ...last, do: [{ type: "ask", turn: "report", prompt: "another", model: "sample", same_thread: false }], paste: { another: "test" } }]), /duplicate turn report/);
  assert.throws(() => compile(d, [first, { ...last, do: [{ type: "wait_turn", turn: "future", timeout_seconds: 10 }] }]), /unknown prior turn future/);
  assert.throws(() => compile({ ...d, desktops: [{ id: "both", surfaces: ["desktop", "slack"] }] }, [first, { ...last, surface: "slack" }]), /unknown prior turn report on slack/);
});

test("started turns require a wait and an explicit show; checks cannot substitute for either", () => {
  const { d, first, last } = fixture();
  assert.throws(() => compile(d, [first, { ...last, do: [{ type: "show", turn: "report", seconds: 5 }] }]), /wait for report before showing/);
  assert.throws(() => compile(d, [first, { ...last, do: [{ type: "return_to_chat", turn: "report" }] }]), /wait for report before checking/);
  assert.throws(() => compile(d, [first, { ...last, do: [{ type: "wait_turn", turn: "report", timeout_seconds: 10 }] }]), /has no show step/);
});

test("show requires the right active chat and same-thread asks require a prior chat", () => {
  const { d, first, last } = fixture();
  assert.throws(() => compile(d, [first, { ...last, do: [{ type: "open_chat", title: "Unrelated" }, { type: "wait_turn", turn: "report", timeout_seconds: 10 }, { type: "show", turn: "report", seconds: 5 }] }]), /return to report/);
  assert.throws(() => compile(d, [{ ...first, do: [{ type: "ask", turn: "report", prompt: "report-prompt", model: "sample", same_thread: true }] }, last]), /same_thread requires a prior chat/);
});

test("YAML rejects duplicate keys and aliases rather than silently changing the manifest", () => {
  assert.throws(() => parseYaml("id: first\nid: second", { maxAliasCount: 0 }));
  assert.throws(() => parseYaml("first: &copy [sample]\nsecond: *copy", { maxAliasCount: 0 }));
});

test("loader enforces filename IDs and reports invalid YAML paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-factory-loader-"));
  try {
    writeFileSync(join(dir, "wrong.yaml"), JSON.stringify(fixture().first));
    assert.throws(() => load(manifest, undefined, dir), /id must match filename/);
    writeFileSync(join(dir, "invalid.yaml"), "bad: [");
    assert.throws(() => readYaml(join(dir, "invalid.yaml")), /Cannot read YAML/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI checks without writing and generates exactly three matching artifacts offline", () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-factory-cli-"));
  const cli = join(root, "generate.ts");
  try {
    const check = spawnSync(process.execPath, [cli, "--check", "--out", dir], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /Valid: acme-default/);
    assert.deepEqual(readdirSync(dir), []);
    const generate = spawnSync(process.execPath, [cli, "--include-optional", "--out", dir], { encoding: "utf8" });
    assert.equal(generate.status, 0, generate.stderr);
    const expected = generateArtifacts(load(manifest), true);
    assert.deepEqual(readdirSync(dir).sort(), Object.keys(expected).sort());
    for (const [name, content] of Object.entries(expected)) assert.equal(readFileSync(join(dir, name), "utf8"), content);
    const invalid = spawnSync(process.execPath, [cli, "--unknown"], { encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
