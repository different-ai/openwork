/**
 * [INPUT]: 依赖批准的 agentic-outreach voiceover，以及 fraimz runner 提供的真实应用驱动、断言和截图能力
 * [OUTPUT]: 对外提供八帧 B2B Outreach 用户旅程 flow，证明动态能力绑定、证据账本、付费审批、发送和跨会话交接
 * [POS]: evals/flows 的用户可见端到端证明，使用外部系统替身验证 OpenWork 编排而不复制供应商实现
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/agentic-outreach.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("agentic-outreach");

export default {
  id: "agentic-outreach",
  title: "TODO: one-line claim — user can do X and sees Y",
  kind: "user-facing",
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 1", {
          voiceover: vo[0],
          // "Maya 用一句话告诉 OpenWork：找出五十家最近三十天正在招聘合规负责人的美国 Series B 安全公司，只为合格的 VP 以上联系人购买已验"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 1 not implemented yet");
          },
          screenshot: { name: "frame-1", requireText: [] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 2", {
          voiceover: vo[1],
          // "OpenWork 把目标整理成一份 Outreach Brief，并实时发现组织已经连接的 Exa、Apollo、FullEnrich 和 Instan"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 2 not implemented yet");
          },
          screenshot: { name: "frame-2", requireText: [] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 3", {
          voiceover: vo[2],
          // "Agent 查询实时来源并生成 lead-ledger.csv；每条候选公司都带有来源链接、观察时间、原始信号、供应商和置信度，因此 Maya 可以追溯"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 3 not implemented yet");
          },
          screenshot: { name: "frame-3", requireText: [] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 4", {
          voiceover: vo[3],
          // "Agent 去重并把候选标记为合格、不合格或待确认，同时解释原因；联系方式仍然为空，Maya 清楚地看到昂贵的数据购买没有发生在资格判断之前。"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 4 not implemented yet");
          },
          screenshot: { name: "frame-4", requireText: [] },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 5", {
          voiceover: vo[4],
          // "Agent 汇报合格联系人数量和最坏情况下的费用并等待决定；Maya 批准后，它才购买联系方式，并把验证状态、实际花费和失败原因写回同一份 Ledger"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 5 not implemented yet");
          },
          screenshot: { name: "frame-5", requireText: [] },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 6", {
          voiceover: vo[5],
          // "Agent 根据每家公司真实发生的信号生成三步触达内容和 campaign.md，并在预览里展示证据引用、重复触达检查、抑制名单和退订保护。"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 6 not implemented yet");
          },
          screenshot: { name: "frame-6", requireText: [] },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 7", {
          voiceover: vo[6],
          // "Maya 查看最终收件人、预计发送量和风险检查，批准这一次启动；Agent 随后调用已连接的发送能力，并把供应商返回的序列标识写入运行账本。"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 7 not implemented yet");
          },
          screenshot: { name: "frame-7", requireText: [] },
        });
      },
    },
    {
      name: "Frame 8",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 8", {
          voiceover: vo[7],
          // "Maya 在一个新会话里要求检查回复，OpenWork 从运行账本恢复上下文并实时查询发送服务；发现积极回复后，Agent 暂停后续触达并生成带完整证据"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 8 not implemented yet");
          },
          screenshot: { name: "frame-8", requireText: [] },
        });
      },
    },
  ],
};
