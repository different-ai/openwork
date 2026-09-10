import { ChevronRight } from "lucide-react";

import type { DemoFlow } from "./landing-demo-flows";

type Props = {
  flows: DemoFlow[];
  activeFlowId: string;
  onSelectFlow: (id: string) => void;
  className?: string;
};

export function LandingAppDemoPanel(props: Props) {
  const activeFlow = props.flows.find((flow) => flow.id === props.activeFlowId) ?? props.flows[0];

  return (
    <div
      className={[
        "relative z-10 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-stretch",
        props.className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="hidden min-w-0 flex-col gap-1 rounded-xl border border-[#F1F5F9] bg-[var(--lp-tonal)] p-2 sm:flex sm:w-[30%]">
        {activeFlow.agents.map((agent) => (
          <div
            key={agent.name}
            className="flex flex-wrap items-center gap-2 rounded-xl p-2 transition-colors hover:bg-[var(--lp-tonal)]"
          >
            <div className="flex items-center gap-2">
              <div className={`h-6 w-6 rounded-full ${agent.color}`}></div>
              <span className="text-xs font-medium">{agent.name}</span>
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
                  aria-pressed={isActive}
                  className={`flex min-w-0 items-center justify-between rounded-xl px-2 py-2.5 text-left text-xs transition-colors ${
                      isActive ? "bg-[var(--lp-tonal)]" : "hover:bg-[var(--lp-tonal)]"
                  }`}
                >
                  <span
                    className={`min-w-0 ${
                      isActive ? "font-medium text-[var(--lp-ink)]" : "text-[var(--lp-body)]"
                    }`}
                  >
                    {flow.categoryLabel}
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

      <div className="flex min-w-0 w-full flex-col overflow-hidden rounded-xl border border-[var(--lp-border)] bg-white shadow-sm sm:w-[70%]">
        <div className="flex flex-col gap-4 px-4 pb-4 pt-4 text-[13px]">
          {activeFlow.chatHistory.map((message, index) => {
            if (message.role === "user") {
              return (
                <div
                  key={`${message.role}-${index}`}
                  className="max-w-full self-end rounded-2xl bg-[var(--lp-tonal)] px-4 py-3 text-left text-[var(--lp-ink)]"
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

        <div className="mt-auto border-t border-[var(--lp-border)] bg-white/50 p-3">
          <div className="mb-2 px-1 text-xs text-[var(--lp-muted)]">Describe your task</div>
          <div className="rounded-xl border border-[#F1F5F9] bg-white p-3 text-xs leading-relaxed text-[#011627] shadow-sm">
            {activeFlow.task}
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
