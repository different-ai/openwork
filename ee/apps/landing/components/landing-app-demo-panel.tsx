import { ChevronRight } from "lucide-react";

import type { DemoFlow } from "./landing-demo-flows";
import { landingDemoFlowTimes } from "./landing-demo-flows";

type Props = {
  flows: DemoFlow[];
  activeFlowId: string;
  onSelectFlow: (id: string) => void;
  timesById?: Record<string, string>;
  className?: string;
};

export function LandingAppDemoPanel(props: Props) {
  const activeFlow = props.flows.find((flow) => flow.id === props.activeFlowId) ?? props.flows[0];
  const timesById = props.timesById ?? landingDemoFlowTimes;

  return (
    <div
      className={[
        "relative z-10 flex flex-col gap-4 md:flex-row md:items-start",
        props.className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex w-full flex-col gap-1 rounded-xl border border-[#F1F5F9] bg-[var(--lp-tonal)] p-2 md:w-1/3">
        {activeFlow.agents.map((agent) => (
          <div
            key={agent.name}
            className="flex cursor-pointer items-center justify-between rounded-xl p-3 transition-colors hover:bg-[var(--lp-tonal)]"
          >
            <div className="flex items-center gap-3">
              <div className={`h-6 w-6 rounded-full ${agent.color}`}></div>
              <span className="text-sm font-medium">{agent.name}</span>
            </div>
            {agent.desc ? <span className="text-xs text-[var(--lp-muted)]">{agent.desc}</span> : null}
          </div>
        ))}

        <div className="mt-4 px-1 pb-1">
          <div className="relative flex flex-col gap-1 pl-3 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-[2px] before:bg-[#F1F5F9] before:content-['']">
            {props.flows.map((flow) => {
              const isActive = flow.id === activeFlow.id;

              return (
                <button
                  key={flow.id}
                  type="button"
                  onClick={() => props.onSelectFlow(flow.id)}
                  className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] transition-colors ${
                      isActive ? "bg-[var(--lp-tonal)]" : "hover:bg-[var(--lp-tonal)]"
                  }`}
                >
                  <span
                    className={`mr-2 truncate ${
                      isActive ? "font-medium text-[var(--lp-ink)]" : "text-[var(--lp-body)]"
                    }`}
                  >
                    {flow.tabLabel}
                  </span>
                  <span className="whitespace-nowrap text-[var(--lp-muted)]">
                    {timesById[flow.id] ?? "Now"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          className="mt-2 rounded-xl px-4 py-2.5 text-left text-[13px] text-[var(--lp-muted)] transition-colors hover:bg-[var(--lp-tonal)] hover:text-[var(--lp-body)]"
        >
          ＋ New task
        </button>
      </div>

      <div className="flex w-full flex-col overflow-hidden rounded-xl border border-[var(--lp-border)] bg-white shadow-sm md:w-2/3">
        <div className="flex flex-col gap-4 px-5 pb-2 pt-5 text-[13px]">
          {activeFlow.chatHistory.map((message, index) => {
            if (message.role === "user") {
              return (
                <div
                  key={`${message.role}-${index}`}
                  className="mt-2 max-w-[85%] self-center rounded-3xl bg-[var(--lp-tonal)] px-5 py-3 text-center text-[var(--lp-ink)]"
                >
                  {message.content}
                </div>
              );
            }

            if (message.role === "timeline") {
              return (
                <div
                  key={`${message.role}-${index}`}
                  className="ml-2 flex flex-col gap-3 text-xs text-[var(--lp-muted)]"
                >
                  {message.items.map((item) => (
                    <div key={item} className="flex items-center gap-2">
                      <ChevronRight size={10} className="text-[var(--lp-faint)]" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              );
            }

            return (
              <div
                key={`${message.role}-${index}`}
                className="ml-2 max-w-[95%] text-[13px] leading-relaxed text-[var(--lp-ink)]"
              >
                {message.content}
              </div>
            );
          })}
        </div>

        <div className="border-t border-white/50 bg-white/50 p-4">
          <div className="mb-2 px-1 text-xs text-[var(--lp-muted)]">Describe your task</div>
          <div className="rounded-xl border border-[#F1F5F9] bg-white p-3.5 text-sm leading-relaxed text-[#011627] shadow-sm">
            {activeFlow.task} <span className="text-[var(--lp-muted)]">[task]</span> {activeFlow.context}{" "}
            <span className="text-[var(--lp-muted)]">[context]</span> {activeFlow.output}{" "}
            <span className="text-[var(--lp-muted)]">[result]</span>
          </div>
          <div className="mt-3 flex items-center justify-end px-1">
            <button
              type="button"
              className="rounded-lg bg-[#011627] px-4 py-2 text-xs font-medium text-white shadow-[0_1px_2px_rgba(17,24,39,0.12)] transition-colors hover:bg-black"
            >
              Run Task
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
