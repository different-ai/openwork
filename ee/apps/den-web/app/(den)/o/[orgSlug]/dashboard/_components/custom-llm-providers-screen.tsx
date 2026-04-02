"use client";

import { Cpu } from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { Dithering } from "@paper-design/shaders-react";

const comingSoonItems = [
  "Standardize provider access across your team.",
  "Keep model choices consistent across shared setups.",
  "Control rollout without reconfiguring every teammate by hand.",
];

export function CustomLlmProvidersScreen() {
  return (
    <div className="mx-auto max-w-[860px] p-8">
      <div className="relative mb-8 flex h-[200px] items-center overflow-hidden rounded-3xl border border-gray-100 px-10">
        <div className="absolute inset-0 z-0">
          <Dithering
            speed={0}
            shape="warp"
            type="4x4"
            size={2.5}
            scale={1}
            frame={41112.4}
            colorBack="#00000000"
            colorFront="#FEFEFE"
            style={{ backgroundColor: "#1C2A30", width: "100%", height: "100%" }}
          >
            <PaperMeshGradient
              speed={0.1}
              distortion={0.8}
              swirl={0.1}
              grainMixer={0}
              grainOverlay={0}
              frame={176868.9}
              colors={["#E0FCFF", "#1D7B9A", "#50F7D4", "#518EF0"]}
              style={{ width: "100%", height: "100%" }}
            />
          </Dithering>
        </div>
        <div className="relative z-10 flex flex-col items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/30 bg-white/20 backdrop-blur-md">
            <Cpu size={24} className="text-white" strokeWidth={1.5} />
          </div>
          <div>
            <span className="mb-2 inline-block rounded-full border border-white/20 bg-white/20 px-2.5 py-1 text-[10px] uppercase tracking-[1px] text-white backdrop-blur-md">
              Coming soon
            </span>
            <h1 className="text-[28px] font-medium tracking-[-0.5px] text-white">
              Custom LLMs
            </h1>
          </div>
        </div>
      </div>

      <p className="mb-6 text-[14px] text-gray-500">
        Standardize provider access for your team.
      </p>

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
    </div>
  );
}
