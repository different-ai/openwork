/**
 * [INPUT]: 依赖批准的 agentic-outreach voiceover、真实 OpenWork Artifact UI 与带商业护栏的 DEV 外部系统替身动作
 * [OUTPUT]: 对外提供八帧 B2B Outreach 用户旅程，证明双账本、哈希审批、控制台和跨会话恢复
 * [POS]: evals/flows 的用户可见端到端证明；替身只生成供应商结果，文件写入、Artifact 渲染和跨会话恢复都走真实应用路径
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("agentic-outreach");
const REQUEST = "找出五十家最近三十天正在招聘合规负责人的美国 Series B 安全公司，只为合格的 VP 以上联系人购买已验证邮箱，总预算不超过 25 美元；没有我的明确批准，绝不发送。";
const CONTACT_APPROVAL = "批准联系人购买：绑定当前冻结的 plan 和 eligible 指纹，仅限 31 个合格 Lead，使用 FullEnrich，最多 31 credits 且不超过 USD 25.00。";
const LAUNCH_APPROVAL = "批准启动 run 20260718T091500Z-series-b-security 的 campaign revision 1，绑定当前显示的 content、audience、sender 和 contract 四个 SHA-256 指纹；由 maya@acme.example 通过 Instantly 发送给 27 个已验证联系人。";

async function ensureSession(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "OpenWork control API" });
  const hasSession = await ctx.eval("(window.__openworkControl.snapshot().route || '').includes('/session/')");
  if (!hasSession) {
    await ctx.waitFor(
      "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
      { timeoutMs: 60_000, label: "session.create_task enabled" },
    );
    await ctx.control("session.create_task");
    await ctx.waitFor(
      "(window.__openworkControl.snapshot().route || '').includes('/session/')",
      { timeoutMs: 60_000, label: "active session route" },
    );
  }
}

async function ensureOutreachProofAction(ctx) {
  const available = await ctx.eval("window.__openworkControl.listActions().some((action) => action.id === 'eval.agentic_outreach.seed' && !action.disabled)");
  if (!available) {
    const clicked = await ctx.eval(`(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((item) => item.getAttribute("aria-label") === "Browser" && !item.disabled);
      button?.click();
      return Boolean(button);
    })()`);
    ctx.assert(clicked, "Could not open the Artifact side panel.");
  }
  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'eval.agentic_outreach.seed' && !action.disabled)",
    { timeoutMs: 30_000, label: "agentic outreach proof action" },
  );
}

async function seedStage(ctx, stage, approvals = {}) {
  await ensureOutreachProofAction(ctx);
  const result = await ctx.control("eval.agentic_outreach.seed", { stage, ...approvals });
  ctx.assert(result?.ok === true, `Stage ${stage} failed: ${JSON.stringify(result)}`);
  const fileName = result.primaryPath.split("/").pop();
  await ctx.waitFor(
    `Array.from(document.querySelectorAll('button[aria-label^="Select tab: "]')).some((button) => button.getAttribute('aria-label') === ${JSON.stringify(`Select tab: ${fileName}`)})`,
    { timeoutMs: 30_000, label: `${fileName} artifact tab` },
  );
  ctx.outreachStageResult = result;
  return result;
}

async function waitForSheet(ctx) {
  await ctx.waitFor(
    "document.querySelectorAll('table input').length >= 40",
    { timeoutMs: 30_000, label: "lead ledger spreadsheet cells" },
  );
}

async function sheetValues(ctx) {
  return ctx.eval("Array.from(document.querySelectorAll('table input')).map((input) => input.value)");
}

async function scrollSheet(ctx, fraction) {
  await ctx.eval(`(() => {
    const table = document.querySelector("table");
    const scroller = table?.parentElement;
    if (!scroller) return false;
    scroller.scrollLeft = (scroller.scrollWidth - scroller.clientWidth) * ${fraction};
    return true;
  })()`);
}

export default {
  id: "agentic-outreach",
  title: "A B2B target becomes an evidence-backed, approval-controlled outreach run",
  kind: "user-facing",
  steps: [
    {
      name: "Setup — active session and Artifact panel",
      run: async (ctx) => {
        await ensureSession(ctx);
        await ensureOutreachProofAction(ctx);
      },
    },
    {
      name: "Frame 1 — one request becomes a frozen Outreach Brief",
      run: async (ctx) => {
        await ctx.prove("Maya states the target, budget, contact rule, and send gate once; OpenWork freezes them in the Run brief", {
          voiceover: vo[0],
          action: async () => {
            await ctx.control("composer.set_text", { text: REQUEST });
            await seedStage(ctx, 1);
            await ctx.waitForText("Outreach Brief", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const body = await ctx.eval("document.body.innerText");
            ctx.assert(body.includes("50 US Series B security companies"), "Target count and segment are missing from the brief.");
            ctx.assert(body.includes("USD 25.00"), "Budget cap is missing from the brief.");
            ctx.assert(body.includes("never send without explicit approval"), "Send approval gate is missing from the brief.");
            ctx.assert(ctx.outreachStageResult.state === "brief", `Expected brief state, got ${ctx.outreachStageResult.state}`);
          },
          screenshot: {
            name: "outreach-brief",
            requireText: ["Outreach Brief", "USD 25.00", "never send without explicit approval"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2 — live capability contracts stay outside the core workflow",
      run: async (ctx) => {
        await ctx.prove("OpenWork shows the live provider plan, exact schema inspection, and mutation safety before any provider call", {
          voiceover: vo[1],
          action: async () => {
            await seedStage(ctx, 2);
            await ctx.waitForText("Live capability plan", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const body = await ctx.eval("document.body.innerText");
            for (const provider of ["Exa", "Apollo", "FullEnrich", "Instantly"]) {
              ctx.assert(body.includes(provider), `${provider} is missing from the live capability plan.`);
            }
            ctx.assert(body.includes("schema inspected live"), "Exact live contract inspection is not visible.");
            ctx.assert(body.includes("approval required"), "Mutation safety is not visible.");
          },
          screenshot: {
            name: "live-capability-plan",
            requireText: ["Live capability plan", "Exa", "Apollo", "FullEnrich", "Instantly", "schema inspected live"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3 — live evidence lands in a traceable Lead Ledger",
      run: async (ctx) => {
        await ctx.prove("The Lead Ledger contains current signals, source URLs, observed times, providers, and confidence", {
          voiceover: vo[2],
          action: async () => {
            await seedStage(ctx, 3);
            await waitForSheet(ctx);
            await scrollSheet(ctx, 0.42);
          },
          assert: async () => {
            const values = await sheetValues(ctx);
            ctx.assert(values.includes("https://jobs.northstar.example/compliance-leader"), "Evidence source URL is missing from the Ledger.");
            ctx.assert(values.includes("2026-07-18T09:18:00Z"), "Observation timestamp is missing from the Ledger.");
            ctx.assert(values.includes("Exa") && values.includes("Apollo"), "Evidence providers are missing from the Ledger.");
            ctx.assert(values.includes("high") && values.includes("medium"), "Evidence confidence is missing from the Ledger.");
          },
          screenshot: {
            name: "lead-ledger-evidence",
            requireText: ["lead-ledger.csv", "Save"],
            rejectText: ["Failed to parse spreadsheet", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4 — qualification happens before contact spend",
      run: async (ctx) => {
        await ctx.prove("Qualified, review, and rejected decisions are explained while every contact remains not requested", {
          voiceover: vo[3],
          action: async () => {
            await seedStage(ctx, 4);
            await waitForSheet(ctx);
            await scrollSheet(ctx, 0.78);
          },
          assert: async () => {
            const values = await sheetValues(ctx);
            ctx.assert(values.includes("qualified") && values.includes("review") && values.includes("rejected"), "Qualification decisions are incomplete.");
            ctx.assert(values.includes("Missing mandatory compliance-leader signal"), "A rejection reason is missing.");
            ctx.assert(values.filter((value) => value === "not_requested").length >= 4, "Contacts were requested before qualification approval.");
            ctx.assert(!values.some((value) => value.includes("@northstar.example")), "A paid contact appeared before approval.");
            ctx.assert(ctx.outreachStageResult.state === "awaiting_contact_approval", "Run did not stop at the contact approval gate.");
          },
          screenshot: {
            name: "qualification-before-spend",
            requireText: ["lead-ledger.csv", "Save"],
            rejectText: ["Failed to parse spreadsheet", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5 — explicit approval unlocks verified contact purchase",
      run: async (ctx) => {
        await ctx.prove("Only after Maya approves the USD 25 ceiling do verified emails and actual costs appear in the same Ledger", {
          voiceover: vo[4],
          action: async () => {
            await ctx.control("composer.set_text", { text: CONTACT_APPROVAL });
            await seedStage(ctx, 5, { contactApproved: true });
            await waitForSheet(ctx);
            await scrollSheet(ctx, 1);
          },
          assert: async () => {
            const values = await sheetValues(ctx);
            ctx.assert(values.includes("maya.chen@northstar.example"), "Verified purchased contact is missing.");
            ctx.assert(values.includes("FullEnrich") && values.includes("verified"), "Provider or verification status is missing.");
            ctx.assert(values.filter((value) => value === "0.80").length >= 2, "Actual per-contact costs were not written back.");
            ctx.assert(ctx.outreachStageResult.state === "acquiring_contacts", "Run did not record contact acquisition state.");
            ctx.assert(ctx.outreachStageResult.writtenFiles.some((path) => path.endsWith("/dashboard.md")), "Outreach Control Center was not refreshed.");
          },
          screenshot: {
            name: "approved-contact-purchase",
            requireText: ["lead-ledger.csv", "Save"],
            rejectText: ["Failed to parse spreadsheet", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6 — evidence-bound sequence and safety checks are previewable",
      run: async (ctx) => {
        await ctx.prove("Campaign revision 1 shows the three touches, evidence bindings, dedupe, suppression, unsubscribe, and stop rules", {
          voiceover: vo[5],
          action: async () => {
            await seedStage(ctx, 6);
            await ctx.waitForText("Campaign — Compliance signal", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const body = await ctx.eval("document.body.innerText");
            ctx.assert(body.includes("Touch 1") && body.includes("Touch 2") && body.includes("Touch 3"), "Three-touch sequence is incomplete.");
            ctx.assert(body.includes("Evidence bindings"), "Evidence bindings are missing.");
            ctx.assert(body.includes("Suppression") && body.includes("Stop on any real reply"), "Suppression or reply stop rule is missing.");
            ctx.assert(body.includes("Launch is blocked until explicit approval"), "Launch gate is missing from the Campaign.");
          },
          screenshot: {
            name: "campaign-safety-preview",
            requireText: ["Campaign — Compliance signal", "Evidence bindings", "Touch 1", "Safety checks"],
            rejectText: ["Not drafted", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 7 — a separate launch approval produces one provider sequence",
      run: async (ctx) => {
        await ctx.prove("Maya's launch approval is tied to revision 1, 27 recipients, the sender, and one provider sequence ID", {
          voiceover: vo[6],
          action: async () => {
            await ctx.control("composer.set_text", { text: LAUNCH_APPROVAL });
            await seedStage(ctx, 7, { launchApproved: true });
            await ctx.waitForText("Outreach Control Center", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const body = await ctx.eval("document.body.innerText");
            ctx.assert(body.includes("State: launched"), "Run is not marked launched in the Control Center.");
            ctx.assert(body.includes("27 accepted"), "Accepted recipient count is missing.");
            ctx.assert(body.includes("27 actual / 31 approved FullEnrich credits"), "Native credit reconciliation is missing.");
            ctx.assert(body.includes("all four hashes match Launch Approval"), "Launch integrity preflight is missing.");
            ctx.assert(body.includes("seq_inst_01KXV_OUTREACH"), "Provider sequence ID is missing.");
          },
          screenshot: {
            name: "approved-launch-ledger",
            requireText: ["Outreach Control Center", "seq_inst_01KXV_OUTREACH", "launched", "Campaign integrity"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 8 — a new session restores the Run and hands off a positive reply",
      run: async (ctx) => {
        await ctx.prove("A new session restores the launched Run from workspace state, pauses future touches, and creates an evidence-backed human handoff", {
          voiceover: vo[7],
          action: async () => {
            await ctx.control("session.create_task");
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'composer.set_text' && !action.disabled)",
              { timeoutMs: 60_000, label: "new session composer" },
            );
            await ctx.control("composer.set_text", { text: `检查 ${ctx.outreachStageResult.runId} 的最新回复并交接积极回复。` });
            const restored = await seedStage(ctx, 8);
            ctx.assert(restored.restoredFromRun === true, "The new session did not restore the launched Run ledger.");
            await ctx.waitForText("Reply Handoff", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const body = await ctx.eval("document.body.innerText");
            ctx.assert(body.includes("remaining touches paused immediately"), "Future touches were not paused after the reply.");
            ctx.assert(body.includes("VP Compliance role opened 9 days ago"), "Original qualifying evidence is missing from handoff.");
            ctx.assert(body.includes("Owner: Maya"), "Human owner is missing from handoff.");
            ctx.assert(body.includes("seq_inst_01KXV_OUTREACH"), "Original sequence context was not restored.");
          },
          screenshot: {
            name: "cross-session-reply-handoff",
            requireText: ["Reply Handoff", "remaining touches paused immediately", "Owner: Maya", "seq_inst_01KXV_OUTREACH"],
            rejectText: ["No replies yet", "Something went wrong"],
          },
        });
      },
    },
  ],
};
