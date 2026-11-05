"use client";

import { Puzzle, Terminal, Users, Webhook, type LucideIcon } from "lucide-react";
import { useExampleStep } from "../use-example-step";
import { ExampleCaption, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { agentsExampleRows, commandsExampleRows, hooksExampleRows, mcpsExampleRows, type PartsExampleRow } from "./parts-example-data";

function PluginName({ name }: { name: string }) {
  return (
    <span className="flex max-w-[40%] shrink-0 items-center gap-1 text-[12px] text-gray-500">
      <Puzzle className="size-3 shrink-0 text-gray-500" strokeWidth={1.5} />
      <span className="truncate">{name}</span>
    </span>
  );
}

function PartsList({ caption, icon: Icon, rows, mono = false }: { caption: string; icon: LucideIcon; rows: readonly PartsExampleRow[]; mono?: boolean }) {
  const step = useExampleStep(rows.length);
  return (
    <div>
      <ExampleCaption>{caption}</ExampleCaption>
      <ExampleRows>
        {rows.map((row, index) => (
          <ExampleRow key={row.title} active={step === index}>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-gray-50 text-gray-500">
              <Icon className="size-4" strokeWidth={1.5} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={`truncate text-[13px] font-medium text-gray-900 ${mono ? "font-mono" : ""}`}>{row.title}</span>
              <span className="truncate text-[12px] text-gray-500">{row.detail}</span>
            </span>
            <PluginName name={row.plugin} />
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}

/** Agents tab example: agents from three plugins, each with the plugin it came with. */
export function PluginAgentsExample() {
  return <PartsList caption="Agents across your plugins" icon={Users} rows={agentsExampleRows} />;
}

/** Commands tab example. */
export function PluginCommandsExample() {
  return <PartsList caption="Commands across your plugins" icon={Terminal} rows={commandsExampleRows} mono />;
}

/** Hooks tab example: what each hook does and when it runs. */
export function PluginHooksExample() {
  return <PartsList caption="Hooks across your plugins" icon={Webhook} rows={hooksExampleRows} />;
}

/** MCPs tab example: the apps inside plugins, with how much the AI can do in each. */
export function PluginMcpsExample() {
  const step = useExampleStep(mcpsExampleRows.length);
  return (
    <div>
      <ExampleCaption>Apps inside your plugins</ExampleCaption>
      <ExampleRows>
        {mcpsExampleRows.map((row, index) => (
          <ExampleRow key={row.service.name} active={step === index}>
            <ExampleServiceMark service={row.service} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.service.name}</span>
              <span className="truncate text-[12px] text-gray-500">{row.tools} the AI can do</span>
            </span>
            <PluginName name={row.plugin} />
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
