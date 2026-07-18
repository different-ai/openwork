/**
 * [INPUT]: 依赖 Agentic Outreach 八阶段 voiceover 与 Artifact 预览类型
 * [OUTPUT]: 对外提供仅供 DEV Fraimz 使用的确定性 Run 文件快照和阶段校验
 * [POS]: session/panel 的证明 Fixture；模拟外部系统结果但写入真实工作区文件，不进入生产能力路径
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { OpenTargetPreview } from "../artifacts/open-target";

export type OutreachEvalStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type OutreachEvalFile = {
  path: string;
  content: string;
  preview: OpenTargetPreview;
};

export type OutreachEvalSnapshot = {
  stage: OutreachEvalStage;
  runId: string;
  state: string;
  primaryPath: string;
  files: OutreachEvalFile[];
};

export const OUTREACH_EVAL_RUN_ID = "20260718T091500Z-series-b-security";
export const OUTREACH_EVAL_STAGES: OutreachEvalStage[] = [1, 2, 3, 4, 5, 6, 7, 8];

export function isOutreachEvalStage(value: unknown): value is OutreachEvalStage {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8;
}

function brief(stage: OutreachEvalStage) {
  const capabilities = stage >= 2
    ? [
      "",
      "## Live capability plan",
      "",
      "| Need | Selected Adapter | Contract | Safety |",
      "|---|---|---|---|",
      "| Current company signal | Exa | schema inspected live | read-only |",
      "| Company/person data | Apollo | schema inspected live | read-only until enrichment |",
      "| Verified work email | FullEnrich | schema inspected live | paid mutation; approval required |",
      "| Sequence + replies | Instantly | schema inspected live | destructive; launch approval required |",
      "",
      "All four organization connections are ready. If one were missing, OpenWork would name that connection and show its exact Connect action instead of inventing a workaround.",
    ]
    : [];

  return [
    "# Outreach Brief",
    "",
    `Run: ${OUTREACH_EVAL_RUN_ID}`,
    "",
    "- Target: 50 US Series B security companies",
    "- Signal: hired or opened a compliance-leader role in the last 30 days",
    "- Persona: VP or above in compliance, security, risk, or trust",
    "- Contact rule: buy only provider-verified work emails after qualification",
    "- Hard budget: USD 25.00",
    "- Launch policy: never send without explicit approval",
    "- Exclusions: prior outreach in 90 days, unsubscribe, hard bounce, duplicate domain",
    ...capabilities,
    "",
  ].join("\n");
}

function ledger(stage: OutreachEvalStage) {
  const header = "lead_id,company,domain,company_url,person_name,title,person_url,signal_type,signal_value,signal_source_url,observed_at,evidence_provider,confidence,qualification,qualification_score,rejection_reason,contact_state,email,contact_provider,verification_status,contact_cost,currency,last_action_at";
  const qualified = stage >= 4;
  const purchased = stage >= 5;
  const rows = [
    ["lead_001", "Northstar Guard", "northstar.example", "https://northstar.example", "Maya Chen", "VP Compliance", "https://people.example/maya-chen", "job_posting", "VP Compliance role opened 9 days ago", "https://jobs.northstar.example/compliance-leader", "2026-07-18T09:18:00Z", "Exa", "high", qualified ? "qualified" : "pending", qualified ? "91" : "", "", purchased ? "verified" : "not_requested", purchased ? "maya.chen@northstar.example" : "", purchased ? "FullEnrich" : "", purchased ? "verified" : "", purchased ? "0.80" : "", purchased ? "USD" : "", "2026-07-18T09:24:00Z"],
    ["lead_002", "Cipher Harbor", "cipherharbor.example", "https://cipherharbor.example", "Jordan Lee", "Chief Trust Officer", "https://people.example/jordan-lee", "executive_hire", "Chief Trust Officer joined 14 days ago", "https://news.cipherharbor.example/trust-officer", "2026-07-18T09:19:00Z", "Apollo", "high", qualified ? "qualified" : "pending", qualified ? "83" : "", "", purchased ? "verified" : "not_requested", purchased ? "jordan.lee@cipherharbor.example" : "", purchased ? "FullEnrich" : "", purchased ? "verified" : "", purchased ? "0.80" : "", purchased ? "USD" : "", "2026-07-18T09:24:20Z"],
    ["lead_003", "Policy Mesh", "policymesh.example", "https://policymesh.example", "Sam Rivera", "Director of Risk", "https://people.example/sam-rivera", "job_posting", "Compliance role appears open but seniority is ambiguous", "https://jobs.policymesh.example/risk", "2026-07-18T09:20:00Z", "Exa", "medium", qualified ? "review" : "pending", qualified ? "61" : "", qualified ? "Persona is below VP and needs review" : "", "not_requested", "", "", "", "", "", "2026-07-18T09:22:00Z"],
    ["lead_004", "Legacy Shield", "legacyshield.example", "https://legacyshield.example", "", "", "", "funding", "Funding is current but no compliance hiring signal", "https://news.legacyshield.example/series-b", "2026-07-18T09:21:00Z", "Apollo", "high", qualified ? "rejected" : "pending", qualified ? "37" : "", qualified ? "Missing mandatory compliance-leader signal" : "", "not_requested", "", "", "", "", "", "2026-07-18T09:22:10Z"],
  ];

  return `${header}\n${rows.map((row) => row.join(",")).join("\n")}\n`;
}

function campaign(stage: OutreachEvalStage) {
  if (stage < 6) return "# Campaign\n\nNot drafted. Qualification and contact approval come first.\n";
  return [
    "# Campaign — Compliance signal",
    "",
    "Revision: 1 · Audience: 27 verified qualified contacts · Sender: maya@acme.example",
    "",
    "## Evidence bindings",
    "",
    "- Northstar Guard → VP Compliance role opened 9 days ago ([source](https://jobs.northstar.example/compliance-leader))",
    "- Cipher Harbor → Chief Trust Officer joined 14 days ago ([source](https://news.cipherharbor.example/trust-officer))",
    "",
    "## Touch 1 — compliance signal",
    "",
    "**Subject:** Compliance hiring",
    "",
    "Saw Northstar opened a VP Compliance role nine days ago. That usually means evidence collection and control ownership are becoming urgent. We help security teams turn those workflows into an audit-ready system without adding another manual queue. Worth comparing notes for 15 minutes?",
    "",
    "## Touch 2 — useful proof",
    "",
    "A practical starting point is mapping each control to its owner, evidence source, and freshness SLA. I can send the one-page template our teams use if helpful.",
    "",
    "## Touch 3 — close the loop",
    "",
    "Should I close the loop, or is compliance automation relevant this quarter? Reply no and I will stop.",
    "",
    "## Safety checks",
    "",
    "- Dedupe: domain + person URL",
    "- Suppression: unsubscribe, hard bounce, prior outreach within 90 days",
    "- Stop on any real reply",
    "- Launch is blocked until explicit approval of revision 1",
    "",
  ].join("\n");
}

function stateFor(stage: OutreachEvalStage) {
  if (stage === 1) return "brief";
  if (stage === 2 || stage === 3) return "researching";
  if (stage === 4) return "awaiting_contact_approval";
  if (stage === 5) return "acquiring_contacts";
  if (stage === 6) return "awaiting_launch_approval";
  if (stage === 7) return "launched";
  return "handed_off";
}

function runJson(stage: OutreachEvalStage) {
  const qualified = stage >= 4;
  const purchased = stage >= 5;
  const launched = stage >= 7;
  const replied = stage >= 8;
  return `${JSON.stringify({
    schema_version: 1,
    run_id: OUTREACH_EVAL_RUN_ID,
    state: stateFor(stage),
    created_at: "2026-07-18T09:15:00Z",
    updated_at: `2026-07-18T09:${String(15 + stage * 3).padStart(2, "0")}:00Z`,
    brief_revision: 1,
    campaign_revision: stage >= 6 ? 1 : 0,
    counts: {
      candidates: stage >= 3 ? 50 : 0,
      qualified: qualified ? 31 : 0,
      review: qualified ? 7 : 0,
      rejected: qualified ? 12 : 0,
      contacts: purchased ? 27 : 0,
      positive_replies: replied ? 3 : 0,
    },
    budget: { currency: "USD", cap: 25, worst_case: qualified ? 24.8 : 0, actual: purchased ? 21.6 : 0 },
    approvals: {
      contact_purchase: purchased ? { approved_at: "2026-07-18T09:25:00Z", amount: 25, provider: "FullEnrich" } : null,
      launch: launched ? { approved_at: "2026-07-18T09:38:00Z", campaign_revision: 1, count: 27 } : null,
    },
    external_refs: launched ? [{ provider: "Instantly", sequence_id: "seq_inst_01KXV_OUTREACH", accepted: 27 }] : [],
  }, null, 2)}\n`;
}

function events(stage: OutreachEvalStage) {
  const lines: Record<string, unknown>[] = [
    { at: "2026-07-18T09:15:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:brief:1`, stage: "brief", status: "completed", capability: "local-ledger" },
  ];
  if (stage >= 3) lines.push({ at: "2026-07-18T09:21:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:research:1`, stage: "research", status: "completed", capability: "live-research-adapters" });
  if (stage >= 5) lines.push({ at: "2026-07-18T09:27:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:contact:batch-1:fullenrich`, stage: "contact", status: "completed", capability: "fullenrich", external_ref: "batch_fe_01KXV", cost: 21.6 });
  if (stage >= 7) lines.push({ at: "2026-07-18T09:39:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:launch:r1:audience-27:instantly`, stage: "launch", status: "completed", capability: "instantly", external_ref: "seq_inst_01KXV_OUTREACH" });
  if (stage >= 8) lines.push({ at: "2026-07-18T09:48:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:reply:evt-positive-003`, stage: "monitoring", status: "completed", capability: "instantly-replies", external_ref: "reply_inst_003" });
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function handoff(stage: OutreachEvalStage) {
  if (stage < 8) return "# Handoff\n\nNo replies yet.\n";
  return [
    "# Reply Handoff",
    "",
    `Run: ${OUTREACH_EVAL_RUN_ID} · Sequence: seq_inst_01KXV_OUTREACH`,
    "",
    "## Positive reply — Northstar Guard",
    "",
    "Maya Chen, VP Compliance, asked for the control-to-evidence template and offered Tuesday afternoon.",
    "",
    "- Evidence: VP Compliance role opened 9 days ago ([source](https://jobs.northstar.example/compliance-leader))",
    "- Reply observed: 2026-07-18T09:48:00Z via Instantly",
    "- Automation: remaining touches paused immediately",
    "- Owner: Maya",
    "- Next action: send the approved template and propose Tuesday 2pm ET",
    "",
    "## Run delta",
    "",
    "3 positive · 1 negative · 2 unsubscribe · 1 bounce · 20 awaiting reply",
    "",
  ].join("\n");
}

function primaryPath(stage: OutreachEvalStage) {
  if (stage <= 2) return "brief.md";
  if (stage <= 5) return "lead-ledger.csv";
  if (stage === 6) return "campaign.md";
  if (stage === 7) return "run.json";
  return "handoff.md";
}

export function buildOutreachEvalSnapshot(stage: OutreachEvalStage): OutreachEvalSnapshot {
  const root = `.openwork/outreach/${OUTREACH_EVAL_RUN_ID}`;
  const files: OutreachEvalFile[] = [
    { path: `${root}/brief.md`, content: brief(stage), preview: "markdown" },
    { path: `${root}/lead-ledger.csv`, content: ledger(stage), preview: "sheet" },
    { path: `${root}/campaign.md`, content: campaign(stage), preview: "markdown" },
    { path: `${root}/run.json`, content: runJson(stage), preview: "markdown" },
    { path: `${root}/events.ndjson`, content: events(stage), preview: "text" },
    { path: `${root}/handoff.md`, content: handoff(stage), preview: "markdown" },
  ];
  const selected = primaryPath(stage);
  const primary = files.find((file) => file.path.endsWith(`/${selected}`));
  if (!primary) throw new Error(`Missing outreach eval primary artifact for stage ${stage}.`);
  return { stage, runId: OUTREACH_EVAL_RUN_ID, state: stateFor(stage), primaryPath: primary.path, files };
}
