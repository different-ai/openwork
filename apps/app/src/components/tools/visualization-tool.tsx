import { useState } from "react";
import { ImageIcon, Monitor, Smartphone } from "lucide-react";
import {
  visualizationSchema,
  type Visualization,
} from "@openwork/types/visualization";
import type { AnyToolPart } from "@/lib/tool-aggregate";
import { Button } from "@/components/ui/button";
import { useMessageList } from "@/components/chat/message-list-provider";

function MockBlock({
  block,
}: {
  block: Visualization["sections"][number]["blocks"][number];
}) {
  switch (block.kind) {
    case "metric":
      return (
        <div className="rounded-xl border bg-background p-4">
          <div className="text-xs text-muted-foreground">{block.label}</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight">
            {block.value ?? "—"}
          </div>
        </div>
      );
    case "field":
      return (
        <div className="space-y-2">
          <div className="text-xs font-medium">{block.label}</div>
          <div className="min-h-9 rounded-lg border bg-background px-3 py-2 text-sm text-muted-foreground">
            {block.value ?? "Enter a value…"}
          </div>
        </div>
      );
    case "button":
      return (
        <div>
          <span className="inline-flex min-h-9 items-center rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background">
            {block.label}
          </span>
        </div>
      );
    case "list":
      return (
        <div className="rounded-xl border bg-background p-4">
          <div className="mb-2 text-sm font-medium">{block.label}</div>
          <ul className="divide-y">
            {block.items?.map((item, index) => (
              <li key={index} className="py-2 text-sm text-muted-foreground">
                {item}
              </li>
            ))}
          </ul>
        </div>
      );
    case "image":
      return (
        <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 p-4 text-xs text-muted-foreground">
          <ImageIcon className="size-5" aria-hidden="true" />
          {block.label}
        </div>
      );
    case "text":
      return (
        <div>
          <div className="text-sm font-medium">{block.label}</div>
          {block.value && (
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
              {block.value}
            </p>
          )}
        </div>
      );
  }
}

export function VisualizationTool({ part }: { part: AnyToolPart }) {
  const [mobile, setMobile] = useState(false);
  const { setPrompt } = useMessageList();
  if (part.state === "output-error")
    return (
      <div role="alert" className="text-sm text-destructive">
        Couldn’t create this visualization. Ask to try again.
      </div>
    );
  if (part.state === "output-denied")
    return (
      <div role="status" className="text-sm text-muted-foreground">
        Visualization wasn’t approved.
      </div>
    );
  if (part.state !== "output-available")
    return (
      <div role="status" className="text-sm text-muted-foreground">
        Creating visualization…
      </div>
    );
  let output: unknown = part.output;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      output = null;
    }
  }
  const parsed = visualizationSchema.safeParse(output);
  if (!parsed.success)
    return (
      <div role="alert" className="text-sm text-muted-foreground">
        This visualization couldn’t be displayed. Ask for a new version.
      </div>
    );
  const design = parsed.data;
  return (
    <section
      aria-label={`Visualization: ${design.title}, revision ${design.revision}`}
      className="my-3 min-w-0 break-words overflow-hidden rounded-2xl border bg-background text-foreground"
      data-testid="visualization-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <div className="text-sm font-medium">{design.title}</div>
          <div className="text-xs text-muted-foreground">
            Visualization · v{design.revision} · Mockup
          </div>
        </div>
        <div className="flex gap-1" role="group" aria-label="Preview size">
          <Button
            variant={mobile ? "ghost" : "secondary"}
            size="sm"
            aria-label="Desktop preview"
            aria-pressed={!mobile}
            onClick={() => setMobile(false)}
          >
            <Monitor className="size-4" />
          </Button>
          <Button
            variant={mobile ? "secondary" : "ghost"}
            size="sm"
            aria-label="Mobile preview"
            aria-pressed={mobile}
            onClick={() => setMobile(true)}
          >
            <Smartphone className="size-4" />
          </Button>
        </div>
      </div>
      <div className="bg-muted/30 p-3 sm:p-5">
        <div
          data-testid="visualization-preview"
          data-viewport={mobile ? "mobile" : "desktop"}
          className={`mx-auto overflow-hidden rounded-xl border bg-background shadow-sm ${mobile ? "max-w-[360px]" : "w-full"}`}
        >
          {design.navigation && (
            <div className="flex flex-wrap gap-x-4 gap-y-2 border-b px-5 py-3 text-xs text-muted-foreground">
              {design.navigation.map((label, index) => (
                <span
                  key={index}
                  className={index === 0 ? "font-medium text-foreground" : ""}
                >
                  {label}
                </span>
              ))}
            </div>
          )}
          <div className="@container space-y-6 p-5">
            {design.description && (
              <p className="text-sm text-muted-foreground">
                {design.description}
              </p>
            )}
            {design.sections.map((section, index) => (
              <section key={index} className="space-y-3">
                <h3 className="text-base font-semibold tracking-tight">
                  {section.title}
                </h3>
                <div
                  className={`grid gap-3 [&>*]:min-w-0 ${mobile ? "grid-cols-1" : section.columns === "three" ? "grid-cols-1 @min-[480px]:grid-cols-3" : section.columns === "two" ? "grid-cols-1 @min-[480px]:grid-cols-2" : "grid-cols-1"}`}
                >
                  {section.blocks.map((block, blockIndex) => (
                    <MockBlock key={blockIndex} block={block} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
        <p className="text-xs text-muted-foreground">
          A design sketch. Controls are for illustration.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setPrompt(
              `Revise visualization "${design.title}" (id: ${design.id}, version ${design.revision}). Create version ${design.revision + 1} with these changes: `,
            )
          }
        >
          Request changes
        </Button>
      </div>
    </section>
  );
}
