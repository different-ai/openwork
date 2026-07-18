/**
 * [INPUT]: 依赖 Agentic Outreach 八阶段 voiceover、双账本/完整性/Outcome Loop 契约与 Artifact 预览类型
 * [OUTPUT]: 对外提供仅供 DEV Fraimz 使用的确定性 Run、商业控制台、durable reply/handoff 文件快照和阶段校验
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

const HASHES = {
  brief: "sha256:6b2f289992d86a8290d17e7c4cbdf1eeb207f4956a2c967a2d533fc4b0c9eafa",
  contactPlan: "sha256:f6968fa245229fdd9928c5f8fce0b45f2939a3bfa28a683ea86bcef68b058a82",
  eligibleLeads: "sha256:606384592f5fcd12953ff06416ad43f7a07c8c3f9d55d3d1dcfba0daa0b063b5",
  campaignContent: "sha256:c7fae09c13bc4cddbdc48e660b2b21ca7c338db6cb9667c229c48a3ecb1e2447",
  audience: "sha256:35362daa03efc0e4e4999d89efd3d3b6417afcca75de8dccb988852c19bfc527",
  sender: "sha256:bb1a65e993dbeb6c97e12a06c73c6626adb68eeeb1d24eb5c360c453fb4405ca",
  senderContract: "sha256:e02adb624712c8372168cf2f298970d02149e3b00ef7cd96d26b3e74bf62180a",
  monitorPlan: "sha256:5c10bb4c06f6904fb5e4d04393429e838f88bd1ea4e0f27b10d83f81eab4f7b6",
  eventFingerprint: "sha256:6edd39165b0c33ee986d7a6d1a9f2dc5eff5a653f82f3c0e0907f9c3282100e3",
  monitorProvision: "sha256:5743d117f145d3742184ed986631014486298a4fec6dac0f39f2335e9db3874e",
  contactResult: "sha256:d52ca307ea162bb10b9a7ad9fdeb48efe5ecde59ac8030961676fa474006abc4",
  launchResult: "sha256:539395f3b88936f988f9a247e1bf9087f620c88a24d864142863e57a5e596550",
  replyResult: "sha256:f836864ed7276afbf2ccdeef4f764025424fab090ce20b8d1d9d0c023c01681b",
} as const;

export function isOutreachEvalStage(value: unknown): value is OutreachEvalStage {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8;
}

function brief(stage: OutreachEvalStage) {
  const capabilities = stage >= 2
    ? [
      "",
      "## Live capability plan",
      "",
      "- Current company signal — Exa · schema inspected live · read-only",
      "- Company/person data — Apollo · schema inspected live · organization OAuth preset ready · read-only until enrichment",
      "- Verified work email — FullEnrich · schema inspected live · organization OAuth preset ready · paid mutation; approval required",
      "- Sequence + replies — Instantly · schema inspected live · destructive; launch approval required",
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
    "- Reply monitor: Activepieces persistent flow · webhook first · 15-minute scheduled fallback",
    "- CRM writeback: not authorized; create local Handoff only",
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

function dashboard(stage: OutreachEvalStage) {
  const qualified = stage >= 4;
  const purchased = stage >= 5;
  const drafted = stage >= 6;
  const launched = stage >= 7;
  const replied = stage >= 8;
  const state = stateFor(stage);
  const nextAction = replied
    ? "Maya owns the positive-reply handoff; all remaining touches for replied Leads stay paused and the durable monitor continues."
    : launched
      ? "Activepieces is monitoring replies and delivery events; any real reply, unsubscribe, or hard bounce pauses future touches."
      : drafted
        ? "Review the 27-recipient Campaign and approve the exact content, audience, sender, provider contract, and monitor hashes."
        : qualified
          ? "Approve the frozen FullEnrich managed-waterfall plan before any contact channel is requested."
          : "Complete live evidence research and qualification before spending contact credits.";

  return [
    "# Outreach Control Center",
    "",
    `Run: ${OUTREACH_EVAL_RUN_ID} · State: **${state}**`,
    "",
    "## Next action",
    "",
    nextAction,
    "",
    "## Funnel",
    "",
    `${stage >= 3 ? 50 : 0} candidates → ${qualified ? 31 : 0} qualified → ${purchased ? 27 : 0} verified → ${replied ? 3 : 0} positive`,
    "",
    `${qualified ? 7 : 0} review · ${qualified ? 12 : 0} rejected · ${purchased ? "87% verified / qualified" : "contact purchase locked"}`,
    "",
    "Evidence: live URLs + observed times · Freshness window: 30 days · Coverage: 50/50 candidates",
    "",
    "## Spend guard",
    "",
    `- Billing currency: USD ${purchased ? "21.60 actual" : "0.00 actual"} / USD 25.00 approved · worst case USD ${qualified ? "24.80" : "0.00"}`,
    `- Native meter: ${purchased ? "27 actual" : "0 actual"} / ${qualified ? "31 approved FullEnrich credits" : "not priced"} · ${purchased ? "4 remaining" : "0 reserved"}`,
    "- Conversion snapshot: 2026-07-18T09:24:00Z · FullEnrich account price · 1 credit = USD 0.80",
    "",
    "## Contact plan",
    "",
    `- Mode: ${qualified ? "managed_waterfall" : "not frozen"} · Provider: ${qualified ? "FullEnrich" : "pending live discovery"}`,
    `- Billing: ${qualified ? "verified result only" : "pending"} · Stop: ${qualified ? "first provider-verified result" : "pending"}`,
    `- Purchase gate: ${purchased ? "approved and reconciled" : qualified ? "awaiting explicit approval" : "locked until qualification"}`,
    `- Plan: ${qualified ? HASHES.contactPlan : "not frozen"}`,
    "",
    "## Campaign integrity",
    "",
    `- Content: ${drafted ? HASHES.campaignContent : "not drafted"}`,
    `- Audience: ${drafted ? HASHES.audience : "not drafted"}`,
    `- Sender: ${drafted ? HASHES.sender : "not drafted"}`,
    `- Live contract: ${drafted ? HASHES.senderContract : "not inspected"}`,
    `- Launch gate: ${launched ? "approved" : drafted ? "awaiting explicit approval" : "locked"}`,
    `- Monitor plan: ${drafted ? HASHES.monitorPlan : "not drafted"}`,
    `- Preflight: ${launched ? "Passed — provider draft and live contracts re-read; all five hashes match Launch Approval" : "not run"}`,
    "",
    "## Monitor health",
    "",
    `- Mode: ${drafted ? "Activepieces persistent flow · webhook + 15-minute fallback" : "not planned"}`,
    `- Flow: ${launched ? "flow_ap_01KXV_REPLY · healthy" : "not enabled"}`,
    `- Cursor: ${replied ? "reply_inst_003 · applied exactly once" : "waiting for first provider event"}`,
    `- Next fallback: ${launched ? "2026-07-18T10:00:00Z" : "not scheduled"}`,
    "",
    "## External execution",
    "",
    launched
      ? "Instantly sequence `seq_inst_01KXV_OUTREACH` · 27 accepted · one idempotent launch"
      : "No sender mutation completed.",
    "",
    "## Outcomes",
    "",
    replied ? "3 positive · 1 negative · 2 unsubscribe · 1 bounce · 20 awaiting reply · USD 7.20 / positive reply" : "No normalized replies yet.",
    "",
  ].join("\n");
}

function runJson(stage: OutreachEvalStage) {
  const qualified = stage >= 4;
  const purchased = stage >= 5;
  const launched = stage >= 7;
  const replied = stage >= 8;
  return `${JSON.stringify({
    schema_version: 3,
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
    budget: {
      currency: "USD",
      cap: 25,
      worst_case: qualified ? 24.8 : 0,
      reserved: 0,
      actual: purchased ? 21.6 : 0,
      meter: { unit: "credits", cap: qualified ? 31 : 0, worst_case: qualified ? 31 : 0, reserved: 0, actual: purchased ? 27 : 0 },
      conversion_snapshot: qualified
        ? { captured_at: "2026-07-18T09:24:00Z", provider: "FullEnrich", native_unit: "credits", units_per_currency: 1.25, source: "account price: 1 credit = USD 0.80" }
        : null,
    },
    contact_plan: {
      revision: qualified ? 1 : 0,
      mode: qualified ? "managed_waterfall" : null,
      providers: qualified
        ? [{ capability: "fullenrich.lookup_verified_contact", label: "FullEnrich", contract_version: "mcp-2026-07-18", max_unit_cost: 0.8, max_native_units: 1, meter_unit: "credits", charges_on: "verified_result" }]
        : [],
      stop_condition: qualified ? "first_provider_verified" : null,
      eligible_lead_ids_hash: qualified ? HASHES.eligibleLeads : null,
      plan_hash: qualified ? HASHES.contactPlan : null,
    },
    integrity: {
      brief_hash: HASHES.brief,
      campaign_content_hash: stage >= 6 ? HASHES.campaignContent : null,
      audience_hash: stage >= 6 ? HASHES.audience : null,
      sender_hash: stage >= 6 ? HASHES.sender : null,
      provider_contract_hash: stage >= 6 ? HASHES.senderContract : null,
    },
    monitor_plan: {
      revision: stage >= 6 ? 1 : 0,
      mode: stage >= 6 ? "persistent_flow" : null,
      capability: stage >= 6 ? "activepieces.ap_build_flow" : null,
      contract_version: stage >= 6 ? "mcp-2026-07-18" : null,
      external_flow_ref: launched ? "flow_ap_01KXV_REPLY" : null,
      event_cursor: replied ? "reply_inst_003" : null,
      last_observed_at: replied ? "2026-07-18T09:48:00Z" : null,
      next_check_at: launched ? "2026-07-18T10:00:00Z" : null,
      plan_hash: stage >= 6 ? HASHES.monitorPlan : null,
    },
    outcomes: {
      accepted: launched ? 27 : 0,
      sent: replied ? 27 : 0,
      delivered: replied ? 26 : 0,
      positive: replied ? 3 : 0,
      negative: replied ? 1 : 0,
      unsubscribe: replied ? 2 : 0,
      out_of_office: 0,
      bounce: replied ? 1 : 0,
      unknown: 0,
      meetings: 0,
      opportunities: 0,
      won: 0,
      revenue: { currency: "USD", amount: 0 },
      cost_per_positive_reply: replied ? 7.2 : null,
    },
    approvals: {
      contact_purchase: purchased
        ? { approved_at: "2026-07-18T09:25:00Z", amount: 25, currency: "USD", native_limit: 31, native_unit: "credits", provider: "FullEnrich", count: 31, brief_revision: 1, eligible_lead_ids_hash: HASHES.eligibleLeads, plan_hash: HASHES.contactPlan }
        : null,
      launch: launched
        ? { approved_at: "2026-07-18T09:38:00Z", campaign_revision: 1, count: 27, campaign_content_hash: HASHES.campaignContent, audience_hash: HASHES.audience, sender_hash: HASHES.sender, provider_contract_hash: HASHES.senderContract, monitor_plan_hash: HASHES.monitorPlan }
        : null,
    },
    external_refs: [
      ...(purchased ? [{ provider: "FullEnrich", result_id: "batch_fe_01KXV", verified: 27 }] : []),
      ...(launched ? [{ provider: "Instantly", sequence_id: "seq_inst_01KXV_OUTREACH", accepted: 27 }] : []),
      ...(launched ? [{ provider: "Activepieces", flow_id: "flow_ap_01KXV_REPLY", status: "enabled" }] : []),
    ],
  }, null, 2)}\n`;
}

function events(stage: OutreachEvalStage) {
  const lines: Record<string, unknown>[] = [
    { at: "2026-07-18T09:15:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:brief:1`, stage: "brief", status: "completed", capability: "local-ledger", input_hash: HASHES.brief, result_hash: HASHES.brief },
  ];
  if (stage >= 3) lines.push({ at: "2026-07-18T09:21:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:research:1`, stage: "research", status: "completed", capability: "live-research-adapters", input_hash: HASHES.brief, result_hash: HASHES.eligibleLeads });
  if (stage >= 5) lines.push({ at: "2026-07-18T09:27:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:contact:batch-1:${HASHES.contactPlan}:fullenrich`, stage: "contact", status: "completed", capability: "fullenrich.lookup_verified_contact", input_hash: HASHES.contactPlan, result_hash: HASHES.contactResult, provider_contract_version: "mcp-2026-07-18", external_ref: "batch_fe_01KXV", cost: { amount: 21.6, currency: "USD" }, meter_delta: { amount: 27, unit: "credits" } });
  if (stage >= 7) lines.push({ at: "2026-07-18T09:39:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:launch:r1:${HASHES.sender}:${HASHES.audience}:${HASHES.campaignContent}:${HASHES.senderContract}:${HASHES.monitorPlan}:instantly`, stage: "launch", status: "completed", capability: "instantly.create_campaign", input_hash: HASHES.campaignContent, result_hash: HASHES.launchResult, provider_contract_version: "mcp-2026-07-18", external_ref: "seq_inst_01KXV_OUTREACH" });
  if (stage >= 7) lines.push({ at: "2026-07-18T09:40:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:monitor:${HASHES.monitorPlan}:activepieces`, stage: "monitoring", status: "completed", capability: "activepieces.ap_build_flow", input_hash: HASHES.monitorPlan, result_hash: HASHES.monitorProvision, provider_contract_version: "mcp-2026-07-18", external_ref: "flow_ap_01KXV_REPLY" });
  if (stage >= 8) lines.push({ at: "2026-07-18T09:48:00Z", action_key: `${OUTREACH_EVAL_RUN_ID}:event-received:${HASHES.eventFingerprint}`, stage: "monitoring", status: "event_received", capability: "instantly.reply_event", input_hash: HASHES.launchResult, result_hash: HASHES.replyResult, external_ref: "reply_inst_003", event_fingerprint: HASHES.eventFingerprint });
  if (stage >= 8) lines.push({ at: "2026-07-18T09:48:02Z", action_key: `${OUTREACH_EVAL_RUN_ID}:event-applied:${HASHES.eventFingerprint}`, stage: "monitoring", status: "event_applied", capability: "instantly.pause_lead", input_hash: HASHES.replyResult, result_hash: HASHES.replyResult, external_ref: "reply_inst_003", event_fingerprint: HASHES.eventFingerprint });
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function handoff(stage: OutreachEvalStage) {
  if (stage < 8) return "# Handoff\n\nNo replies yet.\n";
  return [
    "# Reply Handoff",
    "",
    `Run: ${OUTREACH_EVAL_RUN_ID} · Sequence: seq_inst_01KXV_OUTREACH`,
    "",
    "Monitor: Activepieces `flow_ap_01KXV_REPLY` · webhook + 15-minute fallback",
    "",
    "## Positive reply — Northstar Guard",
    "",
    "Maya Chen, VP Compliance, asked for the control-to-evidence template and offered Tuesday afternoon.",
    "",
    "Commercial result: USD 7.20 per positive reply · no meeting, opportunity, or revenue attributed yet",
    "",
    "- Evidence: VP Compliance role opened 9 days ago ([source](https://jobs.northstar.example/compliance-leader))",
    "- Reply observed: 2026-07-18T09:48:00Z via Instantly",
    "- Event fingerprint: sha256:6edd3916…100e3 · applied exactly once",
    "- Automation: remaining touches paused immediately",
    "- CRM writeback: not authorized; local Handoff only",
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
  if (stage === 7) return "dashboard.md";
  return "handoff.md";
}

export function buildOutreachEvalSnapshot(stage: OutreachEvalStage): OutreachEvalSnapshot {
  const root = `.openwork/outreach/${OUTREACH_EVAL_RUN_ID}`;
  const files: OutreachEvalFile[] = [
    { path: `${root}/brief.md`, content: brief(stage), preview: "markdown" },
    { path: `${root}/lead-ledger.csv`, content: ledger(stage), preview: "sheet" },
    { path: `${root}/campaign.md`, content: campaign(stage), preview: "markdown" },
    { path: `${root}/dashboard.md`, content: dashboard(stage), preview: "markdown" },
    { path: `${root}/run.json`, content: runJson(stage), preview: "markdown" },
    { path: `${root}/events.ndjson`, content: events(stage), preview: "text" },
    { path: `${root}/handoff.md`, content: handoff(stage), preview: "markdown" },
  ];
  const selected = primaryPath(stage);
  const primary = files.find((file) => file.path.endsWith(`/${selected}`));
  if (!primary) throw new Error(`Missing outreach eval primary artifact for stage ${stage}.`);
  return { stage, runId: OUTREACH_EVAL_RUN_ID, state: stateFor(stage), primaryPath: primary.path, files };
}
