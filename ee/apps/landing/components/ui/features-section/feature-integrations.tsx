"use client";

import { useRef } from "react";
import DotsPattern from "../dots-pattern";
import { Marquee } from "../marquee";
import { BRANDS } from "@/constants/brands";
import LogoSymbolIcon from "@/icons/logos/logo-symbol";

const FeatureIntegrations = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} className="bg-background-muted p-lg relative z-0 h-full w-full overflow-hidden rounded-sm">
      <DotsPattern />
      <div className="absolute top-2/5 left-1/2 grid w-full -translate-x-1/2 -translate-y-1/2 place-content-center">
        <div className="bg-background-muted border-primary p-base z-20 aspect-square w-[32rem] rounded-full border border-dashed">
          <div className="bg-primary-dark grid h-full w-full place-content-center rounded-full">
            <LogoSymbolIcon className="w-[14rem] text-white" />
          </div>
        </div>
        <div className="absolute top-1/2 w-full -translate-y-1/2">
          <div className="gap-sm flex flex-col">
            <div className="relative z-0">
              <div className="bg-primary absolute top-1/2 -z-10 h-2 w-full -translate-y-1/2"></div>
              <Marquee>
                {[...BRANDS].map(({ label, Icon }) => (
                  <div
                    key={label}
                    className="border-primary p-sm px-base-sm gap-base-sm bg-background-muted text-base-lg flex items-center rounded-xs border border-dashed font-sans font-medium"
                  >
                    <Icon />
                    <span>{label}</span>
                  </div>
                ))}
              </Marquee>
            </div>
            <div className="relative z-0">
              <div className="bg-primary absolute top-1/2 -z-10 h-2 w-full -translate-y-1/2"></div>
              <Marquee reverse>
                {[...BRANDS].map(({ label, Icon }) => (
                  <div
                    key={label}
                    className="border-primary p-sm px-base-sm gap-base-sm bg-background-muted text-base-lg flex items-center rounded-xs border border-dashed font-sans font-medium"
                  >
                    <Icon />
                    <span>{label}</span>
                  </div>
                ))}
              </Marquee>
            </div>
          </div>
        </div>
      </div>
      <div className="gap-sm absolute bottom-[var(--space-lg)] flex flex-col text-center">
        <h3 className="h3-serif">MCP-native everything</h3>
        <p className="body-base-sm text-primary text-balance">
          Anything that speaks the Model Context Protocol — public registries, your team&apos;s private servers, or a
          script you wrote yesterday — drops into OpenWork without a custom integration layer.
        </p>
      </div>
    </div>
  );
};

export default FeatureIntegrations;
