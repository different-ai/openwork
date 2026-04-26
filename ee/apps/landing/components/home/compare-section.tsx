import DotsPattern from "@/components/ui/dots-pattern";
import Eyebrow from "@/components/ui/eyebrow";
import { Check, X } from "lucide-react";

const COLUMNS = {
  closed: {
    title: "Closed cowork tools",
    sub: "Cursor Cowork · Claude Cowork · Codex",
    items: [
      "Hosted-only — your code lives on someone else's box.",
      "Locked to one provider; switching means rebuilding.",
      "Bespoke skill formats with no portability.",
      "Permissions are a black box; trust the vendor.",
      "Pay per seat, forever."
    ]
  },
  openwork: {
    title: "OpenWork",
    sub: "Open source · local-first · AGPL",
    items: [
      "Local-first — runs on your machine, your folders, your keys.",
      "Bring any provider: Anthropic, OpenAI, Gemini, Mistral, Groq, Ollama.",
      "Standard OpenCode skills, plugins, MCP — fully portable.",
      "Every tool call gated and logged; export the audit trail.",
      "Self-host the whole stack at zero per-seat cost."
    ]
  }
};

const CompareSection = () => {
  return (
    <section className="px-(--container-px)">
      <div className="mx-auto max-w-[120rem]">
        <header className="grid-12 items-end gap-y-base-lg mb-[4.8rem]">
          <div className="col-span-12 md:col-span-7 flex flex-col gap-base">
            <Eyebrow>Compare</Eyebrow>
            <h2 className="text-[4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.2rem]">
              <span className="font-sans font-bold">Why pick a vendor</span>{" "}
              <span className="font-serif font-light italic">when you can pick yourself.</span>
            </h2>
          </div>
          <p className="col-span-12 md:col-span-4 md:col-start-9 font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
            Cowork and Codex ship great experiences — but they decide your provider, your runtime, and where your data
            sits. OpenWork gives you the same product surface with none of the lock-in.
          </p>
        </header>

        <div className="grid-12 gap-base">
          <article className="col-span-12 md:col-span-5 relative overflow-hidden rounded-sm border border-dashed border-foreground/20 bg-background-muted/40 p-(--container-px) flex flex-col gap-base-lg">
            <DotsPattern className="opacity-30" />
            <div className="relative flex flex-col gap-sm">
              <p className="font-sans text-[1.1rem] font-bold uppercase tracking-[0.1em] text-foreground/40">
                {COLUMNS.closed.sub}
              </p>
              <h3 className="text-[2.8rem] leading-[1.1] tracking-[-0.02em]">
                <span className="font-sans font-bold">{COLUMNS.closed.title}</span>
              </h3>
            </div>
            <ul className="relative flex flex-col">
              {COLUMNS.closed.items.map((it, i) => (
                <li
                  key={i}
                  className={
                    "border-foreground/10 grid grid-cols-[auto_1fr] items-start gap-base py-base " +
                    (i === 0 ? "" : "border-t border-dashed")
                  }
                >
                  <span className="border-foreground/20 grid size-[3.2rem] shrink-0 place-content-center rounded-full border border-dashed text-foreground/40">
                    <X className="size-[1.6rem]" />
                  </span>
                  <span className="font-sans text-[1.4rem] font-medium leading-[1.5] text-foreground/65">{it}</span>
                </li>
              ))}
            </ul>
          </article>

          <article className="col-span-12 md:col-span-7 relative overflow-hidden rounded-sm border border-dashed border-primary/40 bg-primary/5 p-(--container-px) flex flex-col gap-base-lg">
            <DotsPattern colorVariable="--primary" className="opacity-30" />
            <div className="relative flex items-start justify-between gap-base">
              <div className="flex flex-col gap-sm">
                <p className="font-sans text-[1.1rem] font-bold uppercase tracking-[0.1em] text-primary">
                  {COLUMNS.openwork.sub}
                </p>
                <h3 className="text-[2.8rem] leading-[1.1] tracking-[-0.02em]">
                  <span className="font-serif font-light italic text-primary">{COLUMNS.openwork.title}</span>
                </h3>
              </div>
              <span className="border-primary/60 bg-background text-primary rounded-full border border-dashed px-base py-xs font-sans text-[1.1rem] font-bold uppercase tracking-[0.08em]">
                Recommended
              </span>
            </div>
            <ul className="relative flex flex-col">
              {COLUMNS.openwork.items.map((it, i) => (
                <li
                  key={i}
                  className={
                    "border-primary/15 grid grid-cols-[auto_1fr] items-start gap-base py-base " +
                    (i === 0 ? "" : "border-t border-dashed")
                  }
                >
                  <span className="border-primary/40 bg-primary text-background grid size-[3.2rem] shrink-0 place-content-center rounded-full border border-dashed">
                    <Check className="size-[1.6rem]" />
                  </span>
                  <span className="font-sans text-[1.4rem] font-medium leading-[1.5] text-foreground/80">{it}</span>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
};

export default CompareSection;
