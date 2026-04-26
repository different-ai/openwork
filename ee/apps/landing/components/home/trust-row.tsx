import Eyebrow from "@/components/ui/eyebrow";
import AnthropicIcon from "@/icons/brands/anthropic-icon";
import GeminiIcon from "@/icons/brands/gemini-icon";
import GroqIcon from "@/icons/brands/groq-icon";
import MistralIcon from "@/icons/brands/mistral-icon";
import OpenAIIcon from "@/icons/brands/openai-icon";
import OpenCodeIcon from "@/icons/brands/opencode-icon";

const PROVIDERS = [
  { label: "Anthropic", Icon: AnthropicIcon },
  { label: "OpenAI", Icon: OpenAIIcon },
  { label: "Gemini", Icon: GeminiIcon },
  { label: "Mistral", Icon: MistralIcon },
  { label: "Groq", Icon: GroqIcon },
  { label: "Ollama", Icon: OpenCodeIcon }
];

const TrustRow = () => {
  return (
    <section className="px-(--container-px)">
      <div className="border-foreground/10 mx-auto flex max-w-[120rem] flex-col items-center gap-base-lg rounded-sm border border-dashed bg-background-muted/40 px-(--container-px) py-[4.8rem]">
        <Eyebrow>Bring your own provider</Eyebrow>

        <ul className="grid w-full grid-cols-2 items-center gap-base sm:grid-cols-3 md:flex md:flex-wrap md:justify-between md:gap-x-base-lg">
          {PROVIDERS.map(({ label, Icon }) => (
            <li
              key={label}
              className="border-foreground/15 hover:border-primary/60 bg-background flex items-center gap-sm rounded-full border border-dashed px-base py-sm font-sans text-[1.4rem] font-medium text-foreground transition-colors"
            >
              <Icon className="size-[1.6rem]" />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};

export default TrustRow;
