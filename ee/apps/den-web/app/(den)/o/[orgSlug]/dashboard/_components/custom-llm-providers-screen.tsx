"use client";

import { Cpu } from "lucide-react";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";

const comingSoonItems = [
  "Standardize provider access across your team.",
  "Keep model choices consistent across shared setups.",
  "Control rollout without reconfiguring every teammate by hand.",
];

export function CustomLlmProvidersScreen() {
  return (
    <DashboardPageTemplate
      icon={Cpu}
      badgeLabel="Coming soon"
      title="Custom LLMs"
      description="Standardize provider access for your team."
      colors={["#E0FCFF", "#1D7B9A", "#50F7D4", "#518EF0"]}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {comingSoonItems.map((text) => (
          <div
            key={text}
            className="flex flex-col gap-3 rounded-2xl border border-gray-100 bg-white p-6"
          >
            <span className="inline-block self-start rounded-full border border-gray-100 bg-gray-50 px-2 py-0.5 text-[10px] uppercase tracking-[1px] text-gray-500">
              Coming soon
            </span>
            <p className="text-[13px] leading-[1.6] text-gray-600">{text}</p>
          </div>
        ))}
      </div>
    </DashboardPageTemplate>
  );
}
