/**
 * [INPUT]: 依赖 outreach-eval-seed 的八阶段确定性快照
 * [OUTPUT]: 验证资格先于付费、两次审批、序列引用与回复暂停的回归测试
 * [POS]: session/panel 的纯契约测试，确保 Fraimz Fixture 与产品不变量同构
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: unknown) => void;
  toHaveLength: (expected: number) => void;
  not: { toContain: (expected: unknown) => void };
};

import { buildOutreachEvalSnapshot, OUTREACH_EVAL_RUN_ID, OUTREACH_EVAL_STAGES, type OutreachEvalStage } from "./outreach-eval-seed";

function file(stage: OutreachEvalStage, suffix: string) {
  const match = buildOutreachEvalSnapshot(stage).files.find((candidate) => candidate.path.endsWith(suffix));
  if (!match) throw new Error(`Missing ${suffix} at stage ${stage}`);
  return match.content;
}

describe("agentic outreach eval snapshots", () => {
  test("all eight stages keep one durable run and six canonical artifacts", () => {
    for (const stage of OUTREACH_EVAL_STAGES) {
      const snapshot = buildOutreachEvalSnapshot(stage);
      expect(snapshot.runId).toBe(OUTREACH_EVAL_RUN_ID);
      expect(snapshot.files).toHaveLength(6);
      expect(snapshot.files.every((item) => item.path.startsWith(`.openwork/outreach/${OUTREACH_EVAL_RUN_ID}/`))).toBe(true);
    }
  });

  test("qualification is visible before any contact purchase", () => {
    const ledger = file(4, "/lead-ledger.csv");
    const run = file(4, "/run.json");
    expect(ledger).toContain("qualified,91");
    expect(ledger).toContain("rejected,37,Missing mandatory compliance-leader signal,not_requested");
    expect(ledger).not.toContain("@northstar.example");
    expect(run).toContain('"state": "awaiting_contact_approval"');
    expect(run).toContain('"contact_purchase": null');
  });

  test("approved contact purchase records verified results and actual spend", () => {
    const ledger = file(5, "/lead-ledger.csv");
    const run = file(5, "/run.json");
    expect(ledger).toContain("maya.chen@northstar.example,FullEnrich,verified,0.80,USD");
    expect(run).toContain('"actual": 21.6');
    expect(run).toContain('"provider": "FullEnrich"');
  });

  test("launch and reply stages preserve the provider reference and stop behavior", () => {
    const launched = file(7, "/run.json");
    const handoff = file(8, "/handoff.md");
    expect(launched).toContain('"campaign_revision": 1');
    expect(launched).toContain('"sequence_id": "seq_inst_01KXV_OUTREACH"');
    expect(handoff).toContain("remaining touches paused immediately");
    expect(handoff).toContain("VP Compliance role opened 9 days ago");
  });
});
