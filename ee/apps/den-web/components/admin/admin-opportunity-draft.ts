import type { OutreachItem } from "@openwork/types/den/admin-organization";

const day = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/**
 * A starting point for a person to edit and send themselves. The words use only
 * what the recipient can already see (their name, workspace, plan, seats, the
 * limit they reached). Telemetry and colleagues in other workspaces decide which
 * draft is offered, never what it says.
 */
export function outreachDraft(item: Pick<OutreachItem, "play" | "organizationName" | "company" | "endsAt">, recipientName: string | null, now = new Date()) {
  const first = recipientName?.trim().split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : "Hi,";
  const workspace = item.organizationName;
  const close = "\n\nBest,\n[Your name]";
  const write = (subject: string, text: string) => ({ subject, body: `${greeting}\n\n${text}${close}` });
  switch (item.play) {
    case "follow_up":
      return write("Following up", `Following up on my earlier note. Is there anything I can help with for ${workspace}?`);
    case "payment":
      return write("Your OpenWork payment", `The latest payment for ${workspace} on OpenWork didn't go through, and I wanted to flag it before anything is interrupted. You can update the payment details from Billing in your workspace. If something else is going on, reply here and I'll sort it out.`);
    case "cancelling": {
      const ended = item.endsAt ? Date.parse(item.endsAt) <= now.getTime() : true;
      return write("Your OpenWork plan", ended
        ? `I saw that the plan for ${workspace} was canceled. I'd value hearing what was missing or what didn't work for you. A two-line reply is plenty, and if a short call is easier I'm happy to set one up.`
        : `I saw that the plan for ${workspace} is set to end${item.endsAt ? ` on ${day(item.endsAt)}` : ""}. Before it does, I'd like to hear what was missing or what didn't work. If a short call is easier, I'm happy to set one up.`);
    }
    case "team_no_plan":
      return write(`${workspace} on OpenWork`, `A few of you in ${workspace} are using OpenWork regularly now. At this point teams usually get more from shared skills, shared connections and one bill. I can walk you through the Team plan and help set it up in 20 minutes. Would a time this week work?`);
    case "seats_full":
      return write(`Room for more of ${workspace}`, `${workspace} has used all of its seats on OpenWork. If you're planning to add more people, I can help you choose the right setup and get them started.`);
    case "company":
      return write("OpenWork for your team", `I help teams get set up on OpenWork. If others${item.company ? ` at ${item.company}` : ""} would use it too, a shared workspace lets you share skills and connections and keep billing in one place. I'm happy to set that up with you. Would a short call this week work?`);
    case "free_limit":
      return write("More room on OpenWork", `You reached the free model limit on OpenWork recently, which usually means it's doing real work for you. The Models add-on lifts that limit. If it helps, I can walk you through what's included or answer any questions.`);
    case "shrinking":
      return write(`${workspace} on OpenWork`, `I'm checking in on how OpenWork is going for the team at ${workspace}. If some of the team ran into snags, or it isn't fitting how they work, I'd like to help. A short session on shared skills and connections usually gets people going again. Would that be useful?`);
    case "lapsed_failed":
      return write("Sorry OpenWork let you down", `Some of your tasks in OpenWork didn't complete the last time you used it, and I'm sorry about that. If you tell me what you were trying to get done, I'll make sure it works, or we can spend 15 minutes and do it together.`);
    case "lapsed_limit":
      return write("Your OpenWork limit has reset", `You reached the free model limit on OpenWork a little while ago. That limit has reset, so you can pick up where you left off, and the Models add-on lifts it if you need more room. Is there anything I can help with?`);
    case "lapsed":
      return write("Checking in", `I wanted to check in on OpenWork for ${workspace}. If something got in the way, or it didn't fit what you needed, I'd value hearing it. And if you'd like a hand getting a workflow running, I'm happy to set up 15 minutes.`);
    case "quiet_paying":
      return write("Checking in", `I'm checking in on how OpenWork is working for ${workspace}. If there's a workflow you'd like help with, or something getting in the way, I'm glad to set up time.`);
  }
}
