import type { ComponentType } from "react";
import { Boxes, Lock, Users, Workflow } from "lucide-react";
import Eyebrow from "@/components/ui/eyebrow";

interface Feature {
  Icon: ComponentType<{ className?: string }>;
  num: string;
  label: string;
  hook: string;
  description: string;
}

const FEATURES: Feature[] = [
  {
    Icon: Lock,
    num: "01",
    label: "Local-first by default",
    hook: "Your filesystem.",
    description:
      "Your filesystem, your credentials, your machine. macOS keychain stores tokens. OpenWork only touches folders you explicitly authorize. Every tool call is gated behind an approval prompt you can review and revoke."
  },
  {
    Icon: Boxes,
    num: "02",
    label: "Built on OpenCode",
    hook: "Native primitives.",
    description:
      "OpenWork is the experience layer; OpenCode is the engine. Skills, plugins, slash commands, and MCP servers all map 1:1 to OpenCode primitives — no parallel implementations, no vendor lock-in."
  },
  {
    Icon: Workflow,
    num: "03",
    label: "Provider-agnostic",
    hook: "Bring your own keys.",
    description:
      "Anthropic, OpenAI, Gemini, Mistral, Groq, or any provider OpenCode supports — including local models via Ollama. Route through your enterprise gateway, or mix providers per agent."
  },
  {
    Icon: Users,
    num: "04",
    label: "Bob configures, Susan consumes",
    hook: "One hub, many surfaces.",
    description:
      "Bob the IT guy packages providers, skills, MCP servers, and rules into a managed Skill Hub. Susan runs them from her desktop, Slack, or Telegram — without ever opening a config file."
  }
];

const WhyUsSection = () => {
  return (
    <section className="px-(--container-px)">
      <div className="grid-12 mx-auto max-w-[140rem] gap-y-[4rem]">
        {/* Sticky side header */}
        <header className="col-span-12 md:col-span-4 md:sticky md:top-[14rem] flex flex-col gap-base-lg self-start">
          <Eyebrow>Why OpenWork</Eyebrow>
          <h2 className="text-[4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.2rem]">
            <span className="font-sans font-bold">Open by default.</span>
            <br />
            <span className="font-serif font-light italic">Yours by design.</span>
          </h2>
          <p className="font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
            Closed cowork tools lock your team into one model, one runtime, one vendor. OpenWork keeps your agents
            open, your data local, and your stack ejectable.
          </p>
          <div className="hidden md:flex items-center gap-sm pt-base">
            <span className="bg-primary/10 text-primary border-primary/30 rounded-full border border-dashed px-base py-xs font-sans text-[1.2rem] font-medium">
              Local-first
            </span>
            <span className="bg-primary/10 text-primary border-primary/30 rounded-full border border-dashed px-base py-xs font-sans text-[1.2rem] font-medium">
              AGPL
            </span>
          </div>
        </header>

        {/* Feature list */}
        <div className="col-span-12 md:col-span-7 md:col-start-6 flex flex-col">
          {FEATURES.map(({ Icon, num, label, hook, description }, i) => (
            <article
              key={num}
              className={
                "border-foreground/10 grid grid-cols-[auto_1fr] gap-base-lg py-[3.2rem] " +
                (i === 0 ? "" : "border-t border-dashed")
              }
            >
              <div className="flex flex-col items-center gap-sm">
                <span className="font-serif italic font-light text-[3.6rem] leading-none text-foreground/40">
                  {num}
                </span>
                <div className="border-primary/40 grid size-[4.4rem] place-content-center rounded-full border border-dashed">
                  <Icon className="size-[2rem] text-primary" />
                </div>
              </div>
              <div className="flex flex-col gap-sm pt-xs">
                <h3 className="text-[2.4rem] leading-[1.15] tracking-[-0.02em]">
                  <span className="font-serif italic font-light text-foreground">{hook}</span>{" "}
                  <span className="font-sans font-bold">{label}.</span>
                </h3>
                <p className="font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
                  {description}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
};

export default WhyUsSection;
