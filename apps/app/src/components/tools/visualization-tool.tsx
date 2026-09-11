import { useState } from "react";
import {
  ChevronDown,
  ChevronDownIcon,
  ImageIcon,
  LayoutTemplate,
  Maximize2,
  Monitor,
  Smartphone,
} from "lucide-react";
import {
  parseVisualization,
  type Visualization,
  type VisualizationBlock,
  type VisualizationSection,
} from "@openwork/types/visualization";
import type { AnyToolPart } from "@/lib/tool-aggregate";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useMessageList } from "@/components/chat/message-list-provider";

const ON_VALUES = /^(on|true|yes|enabled|active|checked)$/i;

function isOn(value: string | undefined) {
  return value !== undefined && ON_VALUES.test(value.trim());
}

function splitCells(row: string) {
  return row.split("|").map((cell) => cell.trim());
}

/** One mock control. Interactive state is local to the preview and never leaves it. */
function MockBlock({ block, compact }: { block: VisualizationBlock; compact: boolean }) {
  const [on, setOn] = useState(() => isOn(block.value));
  const [selected, setSelected] = useState<string | undefined>(() => block.value ?? block.items?.[0]);
  const hint = block.hint ? (
    <p className="mt-1.5 text-xs text-muted-foreground">{block.hint}</p>
  ) : null;

  switch (block.kind) {
    case "metric":
      return (
        <div className="rounded-xl border bg-background p-4">
          <div className="text-xs font-medium text-muted-foreground">{block.label}</div>
          <div className="mt-1.5 text-3xl font-semibold tracking-tight tabular-nums">
            {block.value ?? "—"}
          </div>
          {hint}
        </div>
      );
    case "field":
      return (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">{block.label}</span>
          <Input
            defaultValue={block.value ?? ""}
            placeholder="Enter a value…"
            aria-label={block.label}
          />
          {hint}
        </label>
      );
    case "button": {
      const variant =
        block.tone === "destructive"
          ? "destructive"
          : block.tone === "muted"
            ? "secondary"
            : block.tone === "primary"
              ? "default"
              : "outline";
      return (
        <div>
          <Button type="button" variant={variant} size={compact ? "sm" : "default"}>
            {block.label}
          </Button>
          {hint}
        </div>
      );
    }
    case "toggle":
      return (
        <div className="flex items-start justify-between gap-4 rounded-xl border bg-background px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">{block.label}</div>
            {hint}
          </div>
          <Switch
            checked={on}
            onCheckedChange={setOn}
            aria-label={block.label}
            className="mt-0.5"
          />
        </div>
      );
    case "select":
      return (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">{block.label}</span>
          <span className="relative block">
            <select
              aria-label={block.label}
              value={selected ?? ""}
              onChange={(event) => setSelected(event.target.value)}
              className="h-9 w-full appearance-none rounded-lg border border-border bg-background px-3 pr-9 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              {(block.items ?? [block.value ?? "Choose…"]).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <ChevronDownIcon
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
          </span>
          {hint}
        </label>
      );
    case "segmented":
      return (
        <div className="space-y-1.5">
          <div className="text-xs font-medium">{block.label}</div>
          <div
            role="radiogroup"
            aria-label={block.label}
            className="inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-muted p-1"
          >
            {(block.items ?? []).map((item) => {
              const active = item === selected;
              return (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSelected(item)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-background font-medium text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item}
                </button>
              );
            })}
          </div>
          {hint}
        </div>
      );
    case "chips":
      return (
        <div className="space-y-1.5">
          <div className="text-xs font-medium">{block.label}</div>
          <div className="flex flex-wrap gap-1.5">
            {(block.items ?? []).map((item) => (
              <Badge
                key={item}
                variant={
                  block.tone === "destructive"
                    ? "destructive"
                    : block.tone === "primary" || item === block.value
                      ? "default"
                      : block.tone === "muted"
                        ? "secondary"
                        : "outline"
                }
                className="h-6 px-2.5"
              >
                {item}
              </Badge>
            ))}
          </div>
          {hint}
        </div>
      );
    case "table": {
      const [header, ...rows] = (block.items ?? []).map(splitCells);
      return (
        <div className="min-w-0 space-y-1.5">
          <div className="text-sm font-medium">{block.label}</div>
          <div className="overflow-x-auto rounded-xl border bg-background">
            <table className="w-full text-sm">
              {header && (
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    {header.map((cell, index) => (
                      <th key={index} scope="col" className="px-3 py-2 text-left font-medium">
                        {cell}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody className="divide-y">
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="hover:bg-muted/30">
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="px-3 py-2 align-top">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hint}
        </div>
      );
    }
    case "list":
      return (
        <div className="rounded-xl border bg-background">
          <div className="border-b px-4 py-2.5 text-sm font-medium">{block.label}</div>
          <ul className="divide-y">
            {block.items?.map((item, index) => (
              <li key={index} className="flex items-start gap-2.5 px-4 py-2.5 text-sm hover:bg-muted/30">
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
          {hint && <div className="px-4 pb-3">{hint}</div>}
        </div>
      );
    case "image":
      return (
        <div className="flex aspect-video min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 p-4 text-xs text-muted-foreground">
          <ImageIcon className="size-5" aria-hidden="true" />
          {block.label}
        </div>
      );
    case "text":
      return (
        <div>
          <div className="text-sm font-medium">{block.label}</div>
          {block.value && (
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {block.value}
            </p>
          )}
          {hint}
        </div>
      );
  }
}

function MockSection({ section, mobile }: { section: VisualizationSection; mobile: boolean }) {
  const [open, setOpen] = useState(true);
  const columns = mobile
    ? "grid-cols-1"
    : section.columns === "three"
      ? "grid-cols-1 @min-[560px]:grid-cols-2 @min-[820px]:grid-cols-3"
      : section.columns === "two"
        ? "grid-cols-1 @min-[560px]:grid-cols-2"
        : "grid-cols-1";
  return (
    <section className="rounded-xl border bg-card/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">{section.title}</h3>
          {section.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>
          )}
        </div>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            open ? "" : "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div className={cn("grid gap-4 border-t px-4 py-4 [&>*]:min-w-0", columns)}>
          {section.blocks.map((block, index) => (
            <MockBlock key={index} block={block} compact={mobile} />
          ))}
        </div>
      )}
    </section>
  );
}

/** The mock screen itself: navigation pages, description, and sections. */
function MockScreen({
  design,
  mobile,
  probe = true,
}: {
  design: Visualization;
  mobile: boolean;
  probe?: boolean;
}) {
  const navigation = design.navigation ?? [];
  const hasPages = design.sections.some(
    (section) => section.nav !== undefined && navigation.includes(section.nav),
  );
  const [active, setActive] = useState(() => navigation[0]);
  const visible = hasPages
    ? design.sections.filter(
        (section) => !section.nav || !navigation.includes(section.nav) || section.nav === active,
      )
    : design.sections;

  return (
    <div
      data-testid={probe ? "visualization-preview" : undefined}
      data-viewport={mobile ? "mobile" : "desktop"}
      className={cn(
        "@container mx-auto overflow-hidden rounded-xl border bg-background shadow-sm",
        mobile ? "max-w-[360px]" : "w-full",
      )}
    >
      {navigation.length > 0 && (
        <div
          role={hasPages ? "tablist" : undefined}
          aria-label={hasPages ? "Pages" : undefined}
          className="flex gap-1 overflow-x-auto border-b px-3 pt-2 [scrollbar-width:none]"
        >
          {navigation.map((label) => {
            const current = hasPages ? label === active : label === navigation[0];
            return (
              <button
                key={label}
                type="button"
                role={hasPages ? "tab" : undefined}
                aria-selected={hasPages ? current : undefined}
                aria-current={!hasPages && current ? "page" : undefined}
                onClick={hasPages ? () => setActive(label) : undefined}
                className={cn(
                  "-mb-px shrink-0 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-sm",
                  current
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground",
                  hasPages ? "hover:text-foreground" : "cursor-default",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      <div className="space-y-4 p-4 sm:p-5">
        {design.description && (
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {design.description}
          </p>
        )}
        {visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing on this page yet.
          </p>
        ) : (
          visible.map((section, index) => (
            <MockSection key={`${active ?? ""}-${index}`} section={section} mobile={mobile} />
          ))
        )}
      </div>
    </div>
  );
}

function ViewportToggle({
  mobile,
  onChange,
}: {
  mobile: boolean;
  onChange: (mobile: boolean) => void;
}) {
  return (
    <div className="flex rounded-lg bg-muted p-0.5" role="group" aria-label="Preview size">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Desktop preview"
        aria-pressed={!mobile}
        onClick={() => onChange(false)}
        className={mobile ? "" : "bg-background shadow-xs hover:bg-background"}
      >
        <Monitor className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Mobile preview"
        aria-pressed={mobile}
        onClick={() => onChange(true)}
        className={mobile ? "bg-background shadow-xs hover:bg-background" : ""}
      >
        <Smartphone className="size-4" />
      </Button>
    </div>
  );
}

export function VisualizationTool({ part }: { part: AnyToolPart }) {
  const [mobile, setMobile] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { setPrompt } = useMessageList();

  if (part.state === "output-error") {
    const detail = part.errorText?.split("\n").filter((line) => line.startsWith("- ")) ?? [];
    return (
      <div
        role="alert"
        className="my-3 flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
      >
        <div className="min-w-0 space-y-1">
          <div className="font-medium text-destructive">Couldn’t create this visualization.</div>
          {detail.length > 0 && (
            <ul className="text-xs text-muted-foreground">
              {detail.slice(0, 4).map((line, index) => (
                <li key={index}>{line.replace(/^- /, "")}</li>
              ))}
            </ul>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setPrompt("Try the visualization again, fixing the validation issues from the last attempt.")
          }
        >
          Try again
        </Button>
      </div>
    );
  }
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
  const parsed = parseVisualization(output);
  if (!parsed.ok)
    return (
      <div role="alert" className="text-sm text-muted-foreground">
        This visualization couldn’t be displayed. Ask for a new version.
      </div>
    );
  const design = parsed.data;
  const requestChanges = () =>
    setPrompt(
      `Revise visualization "${design.title}" (id: ${design.id}, version ${design.revision}). Create version ${design.revision + 1} with these changes: `,
    );

  return (
    <section
      aria-label={`Visualization: ${design.title}, revision ${design.revision}`}
      className="my-3 min-w-0 overflow-hidden rounded-2xl border bg-card text-foreground shadow-xs break-words"
      data-testid="visualization-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <LayoutTemplate className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{design.title}</div>
            <div className="text-xs text-muted-foreground">
              Visualization · v{design.revision} · Mockup
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <ViewportToggle mobile={mobile} onChange={setMobile} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open full size"
            onClick={() => setExpanded(true)}
          >
            <Maximize2 className="size-4" />
          </Button>
        </div>
      </div>
      <div className="bg-muted/30 p-3 sm:p-5">
        <MockScreen design={design} mobile={mobile} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
        <p className="text-xs text-muted-foreground">
          A design sketch. Controls are for illustration.
        </p>
        <Button variant="outline" size="sm" onClick={requestChanges}>
          Request changes
        </Button>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-h-[92dvh] gap-0 overflow-y-auto p-0 lg:w-[calc(100vw-3rem)] lg:max-w-[100rem]">
          <div className="flex items-center justify-between gap-3 border-b px-5 py-3 pr-16">
            <DialogTitle className="text-sm font-medium">
              {design.title}
              <span className="ml-2 font-normal text-muted-foreground">
                v{design.revision} · Mockup
              </span>
            </DialogTitle>
            <ViewportToggle mobile={mobile} onChange={setMobile} />
          </div>
          <div className="bg-muted/30 p-4 sm:p-6">
            {expanded && <MockScreen design={design} mobile={mobile} probe={false} />}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
