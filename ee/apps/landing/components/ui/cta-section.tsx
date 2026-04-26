import BubbleButton from "./bubble-button";
import DotsPattern from "./dots-pattern";
import { DOWNLOAD_URL, GITHUB_URL } from "@/constants";

const STATS = [
  { v: "12.4k", l: "GitHub stars" },
  { v: "AGPL", l: "Open license" },
  { v: "20+", l: "Releases / mo" },
  { v: "0", l: "Per-seat fees" }
];

const CtaSection = () => {
  return (
    <section className="px-(--container-px) pb-[6.4rem]">
      <div className="terminal-surface relative mx-auto max-w-[140rem] overflow-hidden rounded-sm border border-dashed term-border">
        <DotsPattern colorVariable="--t-fg" className="opacity-[0.08]" />

        <div className="relative grid-12 items-center gap-y-[4.8rem] px-(--container-px) py-[6.4rem] md:py-[10rem]">
          <div className="col-span-12 md:col-span-7 flex flex-col gap-base-lg">
            <span className="term-border term-muted w-fit rounded-full border border-dashed px-base py-xs font-sans text-[1.1rem] font-bold uppercase tracking-[0.1em]">
              Open the workspace
            </span>
            <h2 className="text-[5.2rem] leading-[1.02] tracking-[-0.025em] sm:text-[6.4rem] md:text-[7.6rem]">
              <span className="font-sans font-bold">Run agents on</span>
              <br />
              <span className="font-serif font-light italic">your own terms.</span>
            </h2>
            <p className="font-sans text-[1.6rem] font-medium leading-[1.55] term-muted max-w-[48rem]">
              Free, open source, and ready to ship to your team. Your machine, your keys, your audit log. No card
              required, ever.
            </p>
            <div className="gap-sm flex flex-wrap items-center pt-sm">
              <BubbleButton isLink href={DOWNLOAD_URL} target="_blank" variant="tertiary">
                Download for free
              </BubbleButton>
              <BubbleButton isLink href={GITHUB_URL} target="_blank" variant="secondary">
                Star on GitHub
              </BubbleButton>
            </div>
          </div>

          <div className="col-span-12 md:col-span-4 md:col-start-9">
            <div className="term-border rounded-sm border border-dashed bg-white/5 p-(--container-px)">
              <ul className="grid grid-cols-2 gap-base-lg">
                {STATS.map((s) => (
                  <li key={s.l} className="flex flex-col gap-2xs">
                    <span className="font-serif italic font-light text-[4rem] leading-none text-secondary">
                      {s.v}
                    </span>
                    <span className="font-sans text-[1.2rem] font-medium uppercase tracking-[0.08em] term-faint">
                      {s.l}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default CtaSection;
