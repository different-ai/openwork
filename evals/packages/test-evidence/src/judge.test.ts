import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { judgeTestRun, type TestArtifact } from "./test-evidence.ts";
import type { VisionRequest } from "./validate.ts";

function artifact(id: number, states: ("pending" | "passed" | "failed")[] = ["pending"]): TestArtifact {
  const judgments = states.map((state, index) => ({ expectation: `screen ${id} claim ${index}`, state, reasoning: "original" }));
  return {
    caption: `screen ${id}`, fileName: `${id}.png`, hash: randomUUID(), route: "#/unit",
    at: "2026-01-01T00:00:00.000Z", description: "", model: "",
    ok: states.includes("pending") ? null : states.every(state => state === "passed"),
    judgments,
    results: judgments.flatMap(judgment => judgment.state === "pending" ? [] : [{
      expectation: judgment.expectation, passed: judgment.state === "passed", evidence: judgment.reasoning,
    }]),
  };
}

async function fixture(artifacts: TestArtifact[]) {
  const dir = await mkdtemp(join(tmpdir(), "evidence-judge-"));
  await Promise.all(artifacts.filter(artifact => artifact.fileName).map(artifact =>
    writeFile(join(dir, artifact.fileName), Buffer.from(artifact.caption))));
  await writeFile(join(dir, "test-run.json"), JSON.stringify({
    name: "unit", dir, createdAt: "2026-01-01", closedAt: "2026-01-01", artifacts,
  }));
  return dir;
}

function controlledJudge() {
  const calls: {
    req: VisionRequest;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  let active = 0;
  let maximum = 0;
  const ask = async (req: VisionRequest) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      return await new Promise<string>((resolve, reject) => calls.push({ req, resolve, reject }));
    } finally {
      active--;
    }
  };
  async function call(id: number, verdict = false) {
    const find = () => calls.find(call => call.req.png.toString() === `screen ${id}`
      && call.req.prompt.startsWith(verdict ? "Judge each" : "Objectively describe"));
    await expect.poll(find).toBeDefined();
    const found = find();
    if (!found) throw new Error("Expected judge call");
    return found;
  }
  async function finish(id: number, expectations: string[], passed = true) {
    const description = await call(id);
    expect(description.req.prompt).not.toContain("Expectations:");
    description.resolve(JSON.stringify({ description: `visible screen ${id}` }));
    const verdict = await call(id, true);
    expect(verdict.req.prompt).toContain(`Independent description: "visible screen ${id}"`);
    expect(verdict.req.prompt).toContain(`Expectations: ${JSON.stringify(expectations)}`);
    verdict.resolve(JSON.stringify({ results: expectations.map(expectation => ({
      expectation, passed, evidence: `visible screen ${id}`,
    })) }));
  }
  return { ask, calls, call, finish, maximum: () => maximum };
}

test("judges at most two screenshots, keeps dependent calls and all claims in capture order", async () => {
  const artifacts = [artifact(0, ["pending", "passed", "pending"]), artifact(1), artifact(2), artifact(3), artifact(4, ["passed"])];
  const assertion = { ...artifact(5, ["failed"]), fileName: "" };
  const dir = await fixture([...artifacts, assertion]);
  const judge = controlledJudge();
  try {
    const result = judgeTestRun(dir, { ask: judge.ask });
    await judge.call(0);
    await judge.call(1);
    expect(judge.calls).toHaveLength(2);
    // Leave the first screenshot blocked; the other worker must keep draining.
    await judge.finish(1, ["screen 1 claim 0"]);
    await judge.finish(2, ["screen 2 claim 0"], false);
    await judge.finish(3, ["screen 3 claim 0"]);
    await judge.finish(0, ["screen 0 claim 0", "screen 0 claim 2"]);
    await expect(result).resolves.toMatchObject({ judgedValidations: 5, failedValidations: 1, pendingValidations: 0, errors: [] });
    expect(judge.maximum()).toBe(2);
    expect(judge.calls).toHaveLength(8);
    const record = JSON.parse(await readFile(join(dir, "test-run.json"), "utf8"));
    expect(record.artifacts.map((item: TestArtifact) => item.caption)).toEqual([...artifacts, assertion].map(item => item.caption));
    expect(record.artifacts[0].judgments).toEqual([
      { expectation: "screen 0 claim 0", state: "passed", reasoning: "visible screen 0" },
      artifacts[0].judgments[1],
      { expectation: "screen 0 claim 2", state: "passed", reasoning: "visible screen 0" },
    ]);
    expect(record.artifacts[4]).toEqual(artifacts[4]);
    expect(record.artifacts[5]).toEqual(assertion);
    expect(record.summary).toMatchObject({ failedArtifacts: 2, pendingArtifacts: 0, failedExpectations: 2, passedExpectations: 6 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider errors in either call stay pending and errors retain capture order", async () => {
  const artifacts = [artifact(0), artifact(1), artifact(2)];
  const dir = await fixture(artifacts);
  const judge = controlledJudge();
  try {
    const result = judgeTestRun(dir, { ask: judge.ask });
    const first = await judge.call(0);
    (await judge.call(1)).reject(new Error("description unavailable"));
    (await judge.call(2)).resolve(JSON.stringify({ description: "screen two" }));
    (await judge.call(2, true)).reject(new Error("verdict unavailable"));
    first.reject(new Error("first unavailable"));
    await expect(result).resolves.toMatchObject({
      judgedValidations: 0, failedValidations: 0, pendingValidations: 3,
      errors: ["screen 0: first unavailable", "screen 1: description unavailable", "screen 2: verdict unavailable"],
    });
    expect(judge.maximum()).toBe(2);
    const record = JSON.parse(await readFile(join(dir, "test-run.json"), "utf8"));
    expect(record.artifacts.map((item: TestArtifact) => ({ ok: item.ok, results: item.results, judgments: item.judgments }))).toEqual(
      ["first unavailable", "description unavailable", "verdict unavailable"].map((message, index) => ({
        ok: null, results: [], judgments: [{ ...artifacts[index].judgments[0], reasoning: `Provider error: ${message}` }],
      })),
    );
    expect(record.summary).toMatchObject({ ok: false, pendingArtifacts: 3, pendingJudgments: 3 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("force rejudges resolved screenshot claims but never assertion evidence", async () => {
  const screenshot = artifact(0, ["passed", "failed"]);
  const assertion = { ...artifact(1, ["failed"]), fileName: "" };
  const dir = await fixture([screenshot, assertion]);
  const judge = controlledJudge();
  try {
    const result = judgeTestRun(dir, { ask: judge.ask, force: true });
    await judge.finish(0, screenshot.judgments.map(item => item.expectation));
    await expect(result).resolves.toMatchObject({ judgedValidations: 2, failedValidations: 0, pendingValidations: 0 });
    const record = JSON.parse(await readFile(join(dir, "test-run.json"), "utf8"));
    expect(record.artifacts[1]).toEqual(assertion);
    expect(judge.calls).toHaveLength(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
