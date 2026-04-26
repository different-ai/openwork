import BubbleButton from "@/components/ui/bubble-button";
import DotsPattern from "@/components/ui/dots-pattern";
import Eyebrow from "@/components/ui/eyebrow";
import { DOWNLOAD_URL } from "@/constants";
import type { ReactNode } from "react";

interface Step {
  num: string;
  step: string;
  hook: string;
  title: string;
  body: string;
  mock: ReactNode;
  align: "left" | "right";
}

const Term = ({ children }: { children: ReactNode }) => (
  <pre className="terminal-surface m-0 p-base-lg font-mono text-[1.3rem] leading-[1.7] overflow-x-auto whitespace-pre min-h-[26rem]">
    {children}
  </pre>
);

const Comment = ({ children }: { children: ReactNode }) => <span className="term-muted">{children}</span>;
const Key = ({ children }: { children: ReactNode }) => <span className="term-key">{children}</span>;
const Val = ({ children }: { children: ReactNode }) => <span className="term-val">{children}</span>;
const Prompt = () => <span className="term-prompt">$</span>;

const STEPS: Step[] = [
  {
    num: "01",
    step: "Boot",
    hook: "Boot it.",
    title: "Run OpenWork on your machine in under a minute",
    body: "Double-click the desktop app or run the orchestrator CLI. OpenCode starts, your skills load, you're chatting locally. No accounts, no cloud config.",
    align: "right",
    mock: (
      <Term>
        <Prompt /> openwork start --workspace ./team{"\n"}
        <Comment>→ opencode server up on :4096</Comment>{"\n"}
        <Comment>→ 12 skills loaded from .opencode/skills/</Comment>{"\n"}
        <Comment>→ 4 MCP servers connected</Comment>{"\n"}
        → <Comment>ready.</Comment> chat at <Val>localhost:3000</Val>
      </Term>
    )
  },
  {
    num: "02",
    step: "Configure",
    hook: "Wire it up.",
    title: "Plug in your stack — any provider, any tool",
    body: "Drop a skill into .opencode/skills/. Add an MCP server for GitHub, Linear, Slack — or write your own plugin. Switch models per-agent without rewriting prompts.",
    align: "left",
    mock: (
      <Term>
        <Comment>// opencode.json</Comment>{"\n"}
        {"{"}{"\n"}
        {"  "}<Key>"model"</Key>: <Val>"anthropic/claude-opus-4-7"</Val>,{"\n"}
        {"  "}<Key>"mcp"</Key>: [<Val>"github"</Val>, <Val>"linear"</Val>, <Val>"slack"</Val>],{"\n"}
        {"  "}<Key>"skills"</Key>: <Val>"./skills"</Val>,{"\n"}
        {"  "}<Key>"approval"</Key>: <Val>"once"</Val>{"\n"}
        {"}"}
      </Term>
    )
  },
  {
    num: "03",
    step: "Distribute",
    hook: "Ship it.",
    title: "Publish to your team — same skill, every surface",
    body: "Push to a Skill Hub. Susan runs it from Slack, Telegram, or the desktop. Same workflow, same permission gates, full audit trail. Eject to your own cloud anytime.",
    align: "right",
    mock: (
      <Term>
        <Prompt /> openwork publish standup-digest{"\n"}
        <Comment>→ packaging skill bundle...</Comment>{"\n"}
        <Comment>→ uploaded to acme/skill-hub@v1.2.0</Comment>{"\n"}
        ✓ available to <Val>14 teammates</Val>{"\n"}
        ✓ Slack: <Val>/standup</Val> · Telegram: <Val>@acme_bot</Val>
      </Term>
    )
  }
];

const HowItWorksSection = () => {
  return (
    <section className="border-foreground/10 relative border-y bg-background-muted/40 py-[8rem] md:py-[12rem]">
      <DotsPattern className="opacity-30" />

      <div className="relative px-(--container-px)">
        <div className="grid-12 mx-auto max-w-[140rem] gap-y-base-lg mb-[6.4rem]">
          <header className="col-span-12 md:col-span-7 flex flex-col gap-base">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="text-[4.4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.6rem]">
              <span className="font-sans font-bold">Configure once.</span>{" "}
              <span className="font-serif font-light italic">Distribute everywhere.</span>
            </h2>
          </header>
          <p className="col-span-12 md:col-span-4 md:col-start-9 md:self-end font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
            OpenWork is a thin layer on top of OpenCode. The same workflow runs on your laptop, on a hosted worker, or
            on a $5/month VPS — your choice.
          </p>
        </div>

        <div className="mx-auto flex max-w-[140rem] flex-col gap-[6.4rem]">
          {STEPS.map((step) => {
            const copyOrder = step.align === "right" ? "md:order-2 md:col-start-8" : "md:order-1";
            const mockOrder = step.align === "right" ? "md:order-1 md:col-start-1" : "md:order-2 md:col-start-7";
            return (
              <div key={step.num} className="grid-12 items-center gap-y-base-lg">
                <div className={`col-span-12 md:col-span-5 flex flex-col gap-base ${copyOrder}`}>
                  <span className="font-serif italic font-light text-[6.4rem] leading-none text-primary/30">
                    {step.num}
                  </span>
                  <p className="font-sans text-[1.2rem] font-bold uppercase tracking-[0.1em] text-primary">
                    Step · {step.step}
                  </p>
                  <h3 className="text-[3.2rem] leading-[1.1] tracking-[-0.02em]">
                    <span className="font-serif italic font-light">{step.hook}</span>{" "}
                    <span className="font-sans font-bold">{step.title}</span>
                  </h3>
                  <p className="font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
                    {step.body}
                  </p>
                </div>
                <div className={`col-span-12 md:col-span-6 ${mockOrder} relative`}>
                  <div className="border-foreground/15 absolute -inset-base rounded-[1.6rem] border border-dashed pointer-events-none" aria-hidden />
                  <div className="terminal-surface relative overflow-hidden rounded-[1.2rem] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.45)]">
                    <div className="term-bar flex items-center gap-sm px-base py-sm">
                      <span className="size-[1rem] rounded-full bg-[#ef4444]" />
                      <span className="size-[1rem] rounded-full bg-[#eab308]" />
                      <span className="size-[1rem] rounded-full bg-[#22c55e]" />
                      <span className="mx-auto font-sans text-[1.2rem] font-medium">step-{step.num}.sh</span>
                    </div>
                    {step.mock}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-center pt-[4.8rem]">
          <BubbleButton isLink href={DOWNLOAD_URL} target="_blank">
            Run the first command
          </BubbleButton>
        </div>
      </div>
    </section>
  );
};

export default HowItWorksSection;
