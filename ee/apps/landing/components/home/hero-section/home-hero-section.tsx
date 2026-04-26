import Link from "next/link";
import BubbleButton from "@/components/ui/bubble-button";
import DotsPattern from "@/components/ui/dots-pattern";
import { DOWNLOAD_URL, GITHUB_URL } from "@/constants";
import GithubIcon from "@/icons/brands/github-icon";
import { Check, Star } from "lucide-react";
import HeroAppPreview from "./hero-app-preview";

const HomeHeroSection = () => {
  return (
    <section className="hero-section relative isolate overflow-hidden pt-[14rem] pb-[6.4rem] md:pt-[18rem] md:pb-[9.6rem]">
      <DotsPattern className="opacity-50" />

      <div className="relative grid-12 items-center gap-y-[6.4rem] px-(--container-px)">
        {/* Left — copy */}
        <div className="col-span-12 flex flex-col gap-base-lg md:col-span-6">
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="border-foreground/15 hover:border-primary/60 bg-background w-fit flex items-center gap-sm rounded-full border border-dashed pl-sm pr-base py-xs font-sans text-[1.2rem] font-medium text-foreground/70 transition-colors group"
          >
            <span className="inline-flex items-center gap-xs">
              <GithubIcon className="size-[1.4rem] text-foreground" />
              <span className="font-mono text-foreground/90 font-bold">12.4k</span>
              <Star className="size-[1.2rem] fill-amber-500 text-amber-500" />
            </span>
            <span className="bg-foreground/15 h-[1.6rem] w-px" />
            <span className="group-hover:text-primary transition-colors">Open source under AGPL — read the source →</span>
          </Link>

          <h1 className="text-[5.6rem] leading-[1.02] tracking-[-0.025em] sm:text-[6.4rem] md:text-[7.2rem]">
            <span className="font-sans font-bold">Ship agents</span>
            <br />
            <span className="font-serif font-light italic">your team will trust.</span>
          </h1>

          <p className="font-sans text-[1.7rem] font-medium leading-[1.55] text-foreground/65 max-w-[48rem]">
            OpenWork is the open-source desktop for agentic workflows. Bring your own model, drop in skills and MCP
            servers, and ship them to Slack, Telegram, or the web — running on your machine, ejectable to your own cloud.
          </p>

          <div className="gap-sm flex flex-wrap items-center pt-sm">
            <BubbleButton isLink href={DOWNLOAD_URL} target="_blank">
              Download for free
            </BubbleButton>
            <BubbleButton isLink href={GITHUB_URL} target="_blank" variant="secondary">
              Star on GitHub
            </BubbleButton>
          </div>

          <ul className="gap-base-lg flex flex-wrap items-center pt-base text-foreground/60 font-sans text-[1.3rem] font-medium">
            <li className="gap-xs flex items-center"><Check className="size-[1.4rem] text-primary" /> Local-first</li>
            <li className="gap-xs flex items-center"><Check className="size-[1.4rem] text-primary" /> Free forever</li>
            <li className="gap-xs flex items-center"><Check className="size-[1.4rem] text-primary" /> macOS · Linux · Windows*</li>
          </ul>

          <div className="flex items-center gap-sm pt-xs">
            <span className="font-sans text-[1.3rem] font-medium text-foreground/60">Backed by</span>
            <div className="flex items-center gap-xs">
              <span className="grid h-[1.8rem] w-[1.8rem] place-content-center rounded-[4px] bg-[#ff6600] font-sans text-[1.1rem] font-bold leading-none text-white">
                Y
              </span>
              <span className="font-sans text-[1.3rem] font-semibold tracking-tight text-foreground/75">
                Combinator
              </span>
            </div>
          </div>
        </div>

        {/* Right — interactive app preview */}
        <div className="col-span-12 md:col-span-6 md:pl-base-lg">
          <HeroAppPreview />
        </div>
      </div>
    </section>
  );
};

export default HomeHeroSection;
