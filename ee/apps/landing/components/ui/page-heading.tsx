import Eyebrow from "@/components/ui/eyebrow";
import { INTRO_DURATION, INTRO_STAGGER, LOADER_DELAY } from "@/constants";
import { cn } from "@/lib/utils";

type PageHeadingProps = {
  eyebrow?: string;
  title: string;
  description?: string;

  duration?: number;
  baseDelay?: number;
  eyebrowDelay?: number;

  align?: "center" | "left";
  className?: string;
};

const PageHeading = ({
  eyebrow,
  title,
  description,

  duration = INTRO_DURATION,
  baseDelay = LOADER_DELAY,
  eyebrowDelay = LOADER_DELAY + INTRO_STAGGER,

  align = "center",
  className,
}: PageHeadingProps) => {
  const isCenter = align === "center";

  return (
    <div className={cn("gap-base flex flex-col", className)}>
      <div
        className={cn(
          "gap-base sm:gap-xl flex flex-col",
          isCenter ? "items-center text-center" : "items-start text-left",
        )}
      >
        {eyebrow && (
          <div data-reveal-group data-reveal-delay={eyebrowDelay}>
            <Eyebrow>{eyebrow}</Eyebrow>
          </div>
        )}

        <div className="gap-base-sm flex flex-col">
          <h1
            data-split="heading"
            data-split-duration={duration}
            data-split-delay={baseDelay - 0.4}
            className="h1-serif"
          >
            <span className="inline-block pb-[1.4rem]">{title}</span>
          </h1>

          {description && (
            <p data-split="heading" data-split-duration={duration} data-split-delay={baseDelay} className="body-base">
              {description}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default PageHeading;
