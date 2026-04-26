import BubbleButton from "@/components/ui/bubble-button";
import Eyebrow from "@/components/ui/eyebrow";
import { DOWNLOAD_URL, GITHUB_URL } from "@/constants";
import type { ReactNode } from "react";

interface Step {
  num: string;
  title: string;
  body: string;
  code: ReactNode;
}

const Comment = ({ children }: { children: ReactNode }) => <span className="term-muted">{children}</span>;
const Key = ({ children }: { children: ReactNode }) => <span className="term-key">{children}</span>;
const Val = ({ children }: { children: ReactNode }) => <span className="term-val">{children}</span>;

const STEPS: Step[] = [
  {
    num: "I",
    title: "Install",
    body: "Pick a surface — desktop or headless.",
    code: (
      <>
        <Comment># Desktop</Comment>{"\n"}
        open openwork.dmg{"\n\n"}
        <Comment># Headless</Comment>{"\n"}
        npm i -g openwork-orchestrator
      </>
    )
  },
  {
    num: "II",
    title: "Authorize a folder",
    body: "OpenWork only touches folders you authorize.",
    code: (
      <>
        openwork start \{"\n"}
        {"  "}--workspace ./my-team \{"\n"}
        {"  "}--approval auto
      </>
    )
  },
  {
    num: "III",
    title: "Drop in a skill",
    body: "Any standard OpenCode skill works.",
    code: (
      <>
        git clone {"<skill>"} \{"\n"}
        {"  "}.opencode/skills/release-notes{"\n\n"}
        openwork skills install
      </>
    )
  },
  {
    num: "IV",
    title: "Pick your model",
    body: "Bring your own keys, switch per-skill.",
    code: (
      <>
        <Comment>// opencode.json</Comment>{"\n"}
        {"{"}{"\n"}
        {"  "}<Key>"model"</Key>: <Val>"opus-4-7"</Val>{"\n"}
        {"}"}
      </>
    )
  }
];

const QuickstartSection = () => {
  return (
    <section className="px-(--container-px)">
      <div className="mx-auto max-w-[140rem]">
        <header className="grid-12 items-end gap-y-base-lg mb-[4.8rem]">
          <div className="col-span-12 md:col-span-7 flex flex-col gap-base">
            <Eyebrow>Quickstart</Eyebrow>
            <h2 className="text-[4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.2rem]">
              <span className="font-serif font-light italic">From zero to agent</span>
              <br />
              <span className="font-sans font-bold">in four commands.</span>
            </h2>
          </div>
          <div className="col-span-12 md:col-span-4 md:col-start-9 flex flex-col gap-base">
            <p className="font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
              OpenWork follows OpenCode conventions to the letter. If you&apos;ve used <code className="font-mono text-[0.92em] bg-background-muted px-xs py-2xs rounded">opencode</code> before, your existing config just works.
            </p>
            <div className="flex flex-wrap gap-sm">
              <BubbleButton isLink href={DOWNLOAD_URL} target="_blank">
                Download
              </BubbleButton>
              <BubbleButton isLink href={GITHUB_URL} target="_blank" variant="secondary">
                GitHub
              </BubbleButton>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-base sm:grid-cols-2 md:grid-cols-4">
          {STEPS.map((step) => (
            <article
              key={step.num}
              className="border-foreground/15 bg-background-muted/40 relative overflow-hidden rounded-sm border border-dashed flex flex-col"
            >
              <div className="flex flex-col gap-xs px-base-lg py-base-lg border-b border-dashed border-foreground/10">
                <span className="font-serif italic font-light text-[5.6rem] leading-none text-primary/40">
                  {step.num}
                </span>
                <h3 className="text-[2rem] leading-[1.1] tracking-[-0.02em]">
                  <span className="font-sans font-bold">{step.title}</span>
                </h3>
                <p className="font-sans text-[1.3rem] font-medium leading-[1.5] text-foreground/65">
                  {step.body}
                </p>
              </div>
              <pre className="terminal-surface m-0 grow p-base font-mono text-[1.2rem] leading-[1.7] overflow-x-auto whitespace-pre">
                <code>{step.code}</code>
              </pre>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
};

export default QuickstartSection;
