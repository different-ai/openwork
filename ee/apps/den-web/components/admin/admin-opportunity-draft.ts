import type { OpportunityItem } from "@openwork/types/den/admin-organization";

const day = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/**
 * A starting point for a person to edit and send themselves. Customer-facing
 * text uses only what the recipient can already see (their name, workspace,
 * plan dates, seats). Telemetry and internal notes inform the choice of draft,
 * never its words; nothing claims a problem or intent we have not established.
 */
export function outreachDraft(item: Pick<OpportunityItem, "kind" | "signals" | "organizationName">, recipientName: string | null) {
  const first = recipientName?.trim().split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : "Hi,";
  const workspace = item.organizationName;
  const signal = (type: OpportunityItem["signals"][number]["type"]) => item.signals.find(entry => entry.type === type);
  const close = "\n\nBest,\n[Your name]";
  switch (item.kind) {
    case "welcome":
      return { subject: "Welcome to OpenWork", body: `${greeting}\n\nThanks for signing up for OpenWork. I help new teams get started, so if a short walkthrough or a pointer to the right guide would be useful, just reply and I'll set it up.${close}` };
    case "activation":
      return { subject: `Getting started with ${workspace}`, body: `${greeting}\n\nI wanted to check in now that ${workspace} is set up on OpenWork. Some teams find a 20-minute getting-started session helps them run their first workflow. Would that be useful this week? If you'd rather explore on your own, no reply needed.${close}` };
    case "expansion":
      return { subject: `Setting up ${workspace} as a team`, body: `${greeting}\n\nAs more of your team gets started with OpenWork, I'd be glad to run a short team setup session: shared skills, connections and a few workflows that tend to help groups get going. Would a time next week work?${close}` };
    case "declining":
      return { subject: "Checking in", body: `${greeting}\n\nI'm checking in to see how OpenWork is working for ${workspace}. If there's a workflow you'd like help with, or anything that's getting in the way, I'm happy to set up time.${close}` };
    case "commercial": {
      const plan = signal("plan_ending"), trial = signal("trial_ending");
      if (plan?.at) return { subject: "Your OpenWork plan", body: `${greeting}\n\nYour OpenWork plan for ${workspace} is scheduled to end on ${day(plan.at)}. If there's anything we could do better, or you'd like to talk through options, I'd value hearing from you.${close}` };
      if (trial?.at) return { subject: "Your OpenWork trial", body: `${greeting}\n\nYour OpenWork trial for ${workspace} ends on ${day(trial.at)}. If it would help, I can walk you through plan options or answer any questions before then.${close}` };
      return { subject: `Room for more of ${workspace}`, body: `${greeting}\n\n${workspace} is close to its seat limit on OpenWork. If you're planning to add more people, I can help you choose the right setup.${close}` };
    }
    case "follow_up":
      return { subject: "Following up", body: `${greeting}\n\nFollowing up on my earlier note. Is there anything I can help with for ${workspace}?${close}` };
  }
}
