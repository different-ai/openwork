import DotsPattern from "@/components/ui/dots-pattern";
import Eyebrow from "@/components/ui/eyebrow";
import AnthropicIcon from "@/icons/brands/anthropic-icon";
import GeminiIcon from "@/icons/brands/gemini-icon";
import GroqIcon from "@/icons/brands/groq-icon";
import MistralIcon from "@/icons/brands/mistral-icon";
import OpenAIIcon from "@/icons/brands/openai-icon";
import type { ComponentType } from "react";

interface Provider {
  name: string;
  Icon: ComponentType<{ className?: string }>;
  models: string;
  highlight?: boolean;
}

const PROVIDERS: Provider[] = [
  { name: "Anthropic", Icon: AnthropicIcon, models: "Opus 4.7, Sonnet 4.6, Haiku 4.5", highlight: true },
  { name: "OpenAI", Icon: OpenAIIcon, models: "GPT-5, o-series, GPT-4.1" },
  { name: "Google", Icon: GeminiIcon, models: "Gemini 2.x Pro, Flash" },
  { name: "Mistral", Icon: MistralIcon, models: "Large 2, Codestral" },
  { name: "Groq", Icon: GroqIcon, models: "Llama, Mixtral, DeepSeek" }
];

const ProvidersSection = () => {
  return (
    <section className="px-(--container-px)">
      <div className="grid-12 mx-auto max-w-[140rem] items-end gap-y-base-lg mb-[4.8rem]">
        <header className="col-span-12 md:col-span-6 flex flex-col gap-base">
          <Eyebrow>Bring your own model</Eyebrow>
          <h2 className="text-[4rem] leading-[1.05] tracking-[-0.025em] sm:text-[5.2rem]">
            <span className="font-serif font-light italic">Five</span>{" "}
            <span className="font-sans font-bold">providers.</span>
            <br />
            <span className="font-sans font-bold">One</span>{" "}
            <span className="font-serif font-light italic">config file.</span>
          </h2>
        </header>
        <p className="col-span-12 md:col-span-5 md:col-start-8 font-sans text-[1.5rem] font-medium leading-[1.55] text-foreground/65">
          OpenWork inherits OpenCode&apos;s provider system. Drop your keys in{" "}
          <code className="font-mono text-[0.92em] bg-background-muted px-xs py-2xs rounded">opencode.json</code>,
          route per-skill, and switch models without rewriting a single prompt. Local models via Ollama work too.
        </p>
      </div>

      <div className="mx-auto grid max-w-[140rem] grid-cols-1 gap-base sm:grid-cols-2 md:grid-cols-12 md:grid-rows-2">
        {/* Featured tile (Anthropic) — always-dark, spans 6 cols × 2 rows */}
        <article className="terminal-surface md:col-span-6 md:row-span-2 relative isolate overflow-hidden rounded-sm p-[3.2rem] flex flex-col justify-between min-h-[36rem]">
          <DotsPattern colorVariable="--t-fg" className="opacity-[0.08]" />
          <div className="relative flex flex-col gap-base">
            <span className="font-sans text-[1.1rem] font-bold uppercase tracking-[0.12em] text-secondary">
              Default · recommended
            </span>
            <div className="term-border grid size-[6.4rem] place-content-center rounded-full border border-dashed">
              <AnthropicIcon className="size-[3.2rem]" />
            </div>
            <h3 className="text-[3.6rem] leading-[1.05] tracking-[-0.02em]">
              <span className="font-sans font-bold">Anthropic.</span>{" "}
              <span className="font-serif font-light italic term-muted">The reasoning workhorse.</span>
            </h3>
            <p className="font-sans text-[1.5rem] font-medium leading-[1.55] term-muted">
              Claude Opus 4.7, Sonnet 4.6, and Haiku 4.5 — all wired up by default. Switch with one config line.
            </p>
          </div>
          <ul className="relative flex flex-wrap gap-xs pt-base-lg">
            {["Opus 4.7", "Sonnet 4.6", "Haiku 4.5", "Tool use", "Vision"].map((c) => (
              <li
                key={c}
                className="term-border inline-flex items-center rounded-full border border-dashed px-base py-xs font-sans text-[1.2rem] font-medium"
              >
                {c}
              </li>
            ))}
          </ul>
        </article>

        {/* 4 sub-tiles — 3 cols × 1 row each */}
        {PROVIDERS.slice(1).map(({ name, Icon, models }) => (
          <article
            key={name}
            className="md:col-span-3 relative isolate overflow-hidden rounded-sm bg-background-muted/60 border border-dashed border-foreground/15 p-base-lg flex flex-col gap-sm min-h-[18rem]"
          >
            <div className="border-primary/40 grid size-[3.6rem] place-content-center rounded-full border border-dashed">
              <Icon className="size-[1.8rem] text-primary" />
            </div>
            <h3 className="font-sans text-[1.8rem] font-bold tracking-[-0.02em]">{name}</h3>
            <p className="font-sans text-[1.3rem] font-medium leading-[1.5] text-foreground/65 grow">{models}</p>
            <span className="text-primary font-sans text-[1.2rem] font-bold uppercase tracking-[0.08em]">
              Available
            </span>
          </article>
        ))}
      </div>

      <p className="mx-auto mt-base-lg max-w-[140rem] text-center font-sans text-[1.3rem] font-medium text-foreground/50">
        Plus any provider OpenCode supports — Ollama for local models, self-hosted gateways, custom endpoints.
      </p>
    </section>
  );
};

export default ProvidersSection;
