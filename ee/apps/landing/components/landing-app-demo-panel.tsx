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
    <div className={["relative z-10 flex flex-col gap-4 md:flex-row", props.className].filter(Boolean).join(" ")}>
      <div className="flex w-full flex-col gap-1 rounded-2xl border border-gray-100 bg-gray-50 p-2 md:w-1/3">
        <div className="flex items-center justify-between rounded-xl bg-gray-100/90 p-3">
          <div className="flex items-center gap-3">
            <div className={`h-6 w-6 rounded-full ${activeFlow.activeAgent.color}`}></div>
            <span className="text-sm font-medium">{activeFlow.activeAgent.name}</span>
          </div>
          <span className="text-xs text-gray-400">Active</span>
        </div>

        {activeFlow.agents.map((agent) => (
          <div
            key={agent.name}
            className="flex cursor-pointer items-center justify-between rounded-xl p-3 transition-colors hover:bg-gray-50/80"
          >
            <div className="flex items-center gap-3">
              <div className={`h-6 w-6 rounded-full ${agent.color}`}></div>
              <span className="text-sm font-medium">{agent.name}</span>
            </div>
            <span className="text-xs text-gray-400">{agent.desc}</span>
          </div>
        ))}

        <div className="mt-4 px-1 pb-1">
          <div className="relative flex flex-col gap-1 pl-3 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-[2px] before:bg-gray-100 before:content-['']">
            {props.flows.map((flow) => {
              const isActive = flow.id === activeFlow.id;

              return (
                <button
                  key={flow.id}
                  type="button"
                  onClick={() => props.onSelectFlow(flow.id)}
                  className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] transition-colors ${
                    isActive ? "bg-gray-100/80" : "hover:bg-gray-50/80"
                  }`}
                >
                  <span
                    className={`mr-2 truncate ${
                      isActive ? "font-medium text-gray-700" : "text-gray-600"
                    }`}
                  >
                    {flow.tabLabel}
                  </span>
                  <span className="whitespace-nowrap text-gray-400">
                    {timesById[flow.id] ?? "Now"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex min-h-[400px] w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm md:w-2/3">
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6 text-[13px]">
          {activeFlow.chatHistory.map((message, index) => {
            if (message.role === "user") {
              return (
                <div
                  key={`${message.role}-${index}`}
                  className="mt-2 max-w-[85%] self-center rounded-3xl bg-gray-100/80 px-5 py-3 text-center text-gray-800"
                >
                  {message.content}
                </div>
              );
            }

            if (message.role === "timeline") {
              return (
                <div
                  key={`${message.role}-${index}`}
                  className="ml-2 flex flex-col gap-3 text-xs text-gray-400"
                >
                  {message.items.map((item) => (
                    <div key={item} className="flex items-center gap-2">
                      <ChevronRight size={10} className="text-gray-300" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              );
            }

            return (
              <div
                key={`${message.role}-${index}`}
                className="mb-2 ml-2 max-w-[95%] text-[13px] leading-relaxed text-gray-800"
              >
                {message.content}
              </div>
            );
          })}
        </div>

        <div className="border-t border-white/50 bg-white/50 p-4">
          <div className="mb-2 px-1 text-xs text-gray-400">Describe your task</div>
          <div className="rounded-xl border border-gray-100 bg-white p-3.5 text-sm leading-relaxed text-[#011627] shadow-sm">
            {activeFlow.task} <span className="text-gray-400">[task]</span> {activeFlow.context}{" "}
            <span className="text-gray-400">[context]</span> {activeFlow.output}{" "}
            <span className="text-gray-400">[result]</span>
          </div>
          <div className="mt-3 flex items-center justify-end px-1">
            <button
              type="button"
              className="rounded-full bg-[#011627] px-6 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-black"
            >
              Run Task
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
