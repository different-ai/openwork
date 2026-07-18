/**
 * [INPUT]: 依赖 outreach-eval-seed 的八阶段确定性快照、双账本与完整性哈希
 * [OUTPUT]: 验证资格先于付费、瀑布计划、哈希审批、控制台、序列引用与回复暂停的回归测试
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
  test("all eight stages keep one durable run and seven canonical artifacts", () => {
    for (const stage of OUTREACH_EVAL_STAGES) {
      const snapshot = buildOutreachEvalSnapshot(stage);
      expect(snapshot.runId).toBe(OUTREACH_EVAL_RUN_ID);
      expect(snapshot.files).toHaveLength(7);
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

  test("the live provider plan exposes organization OAuth presets without SDK wiring", () => {
    const providerPlan = file(2, "/brief.md");
    expect(providerPlan).toContain("Apollo · schema inspected live · organization OAuth preset ready");
    expect(providerPlan).toContain("FullEnrich · schema inspected live · organization OAuth preset ready");
  });

  test("approved contact purchase records managed-waterfall hashes and both spend ledgers", () => {
    const ledger = file(5, "/lead-ledger.csv");
    const run = file(5, "/run.json");
    expect(ledger).toContain("maya.chen@northstar.example,FullEnrich,verified,0.80,USD");
    expect(run).toContain('"actual": 21.6');
    expect(run).toContain('"provider": "FullEnrich"');
    expect(run).toContain('"mode": "managed_waterfall"');
    expect(run).toContain('"stop_condition": "first_provider_verified"');
    expect(run).toContain('"unit": "credits"');
    expect(run).toContain('"native_limit": 31');
    expect(run).toContain('"eligible_lead_ids_hash": "sha256:');
    expect(run).toContain('"plan_hash": "sha256:');
  });

  test("launch approval is integrity-bound and the Control Center exposes its preflight", () => {
    const launched = file(7, "/run.json");
    const dashboard = file(7, "/dashboard.md");
    const handoff = file(8, "/handoff.md");
    expect(launched).toContain('"campaign_revision": 1');
    expect(launched).toContain('"campaign_content_hash": "sha256:');
    expect(launched).toContain('"audience_hash": "sha256:');
    expect(launched).toContain('"sender_hash": "sha256:');
    expect(launched).toContain('"provider_contract_hash": "sha256:');
    expect(launched).toContain('"sequence_id": "seq_inst_01KXV_OUTREACH"');
    expect(dashboard).toContain("Outreach Control Center");
    expect(dashboard).toContain("all four hashes match Launch Approval");
    expect(dashboard).toContain("27 actual / 31 approved FullEnrich credits");
    expect(handoff).toContain("remaining touches paused immediately");
    expect(handoff).toContain("VP Compliance role opened 9 days ago");
  });
});
