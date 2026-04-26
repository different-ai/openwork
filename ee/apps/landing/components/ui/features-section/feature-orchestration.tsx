"use client";

import { useRef } from "react";
import DotsPattern from "../dots-pattern";
import GmailIcon from "@/icons/brands/gmail-icon";
import NotionIcon from "@/icons/brands/notion-icon";
import SlackIcon from "@/icons/brands/slack-icon";
import LogoSymbolIcon from "@/icons/logos/logo-symbol";
import LockIcon from "@/icons/ui/lock-icon";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import MotionPathPlugin from "gsap/MotionPathPlugin";

gsap.registerPlugin(MotionPathPlugin);

// Constants
const ANIMATION_CONFIG = {
  ease: "primary",
  duration: 0.7,
  rotateDuration: 4,
  cycles: 360,
} as const;

const CIRCLE_ROTATIONS = {
  small: 314,
  medium: -327,
  big: 90,
} as const;

const ICON_POSITIONS = {
  small: 0.125,
  medium: 0,
  big: 0.82,
} as const;

// Types
interface CircleNodeProps {
  className: string;
  children: React.ReactNode;
}

interface CirclePathProps {
  id: string;
  viewBox: string;
  d: string;
  className: string;
}

interface IconCircleProps {
  className: string;
  icon: React.ReactNode;
}

// Components
const CircleNode = ({ className, children }: CircleNodeProps) => (
  <div
    className={`${className} bg-background-muted border-primary absolute top-0 z-10 grid size-[4.8rem] place-content-center rounded-full border border-dashed`}
  >
    {children}
  </div>
);

const CirclePath = ({ id, viewBox, d, className }: CirclePathProps) => (
  <svg className={className} viewBox={viewBox} fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d={d} className="stroke-primary" id={id} />
  </svg>
);

const IconCircle = ({ className, icon }: IconCircleProps) => (
  <CircleNode className={className}>
    {icon}
    <div className="bg-primary/50 circle-pulse absolute top-0 left-0 -z-10 h-full w-full scale-0 animate-pulse rounded-full"></div>
  </CircleNode>
);

const FeatureOrchestration = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  const setupMotionPath = (elements: HTMLDivElement[], path: SVGPathElement, positions: number[] | "even") => {
    elements.forEach((el, index) => {
      const progress = positions === "even" ? index / elements.length : positions[index];
      if (progress !== undefined) {
        gsap.set(el, {
          motionPath: {
            path,
            align: path,
            alignOrigin: [0.5, 0.5],
            autoRotate: true,
            start: progress,
            end: progress,
          },
        });
      }
    });
  };

  const createAnimationTimeline = () => {
    const tl = gsap.timeline({
      paused: true,
      defaults: {
        ease: ANIMATION_CONFIG.ease,
        duration: ANIMATION_CONFIG.duration,
      },
    });

    // Circle rotations
    tl.to(".circle-small-wrapper", {
      rotate: `${CIRCLE_ROTATIONS.small + ANIMATION_CONFIG.cycles}deg`,
      duration: ANIMATION_CONFIG.rotateDuration,
    });

    tl.to(
      ".circle-medium-wrapper",
      {
        rotate: `${CIRCLE_ROTATIONS.medium - ANIMATION_CONFIG.cycles}deg`,
        duration: ANIMATION_CONFIG.rotateDuration,
        ease: "back.inOut",
      },
      "<",
    );

    tl.to(
      ".circle-big-wrapper",
      {
        rotate: `${CIRCLE_ROTATIONS.big + ANIMATION_CONFIG.cycles}deg`,
        duration: ANIMATION_CONFIG.rotateDuration,
        ease: "expo.inOut",
      },
      "<",
    );

    // Pulse animations
    tl.to(".pulse", {
      height: "100%",
      transformOrigin: "top",
    });

    tl.to(".circle-small-icon .circle-pulse", { scale: 1.25 }, "<+=0.02");

    tl.to(".circle-medium-icon .circle-pulse", { scale: 1.25 }, "<");

    tl.to(".circle-big-icon .circle-pulse", { scale: 1.25 }, "<");

    tl.to(".pulse", {
      width: "120%",
      transformOrigin: "center",
    });

    return tl;
  };

  useGSAP(
    () => {
      const container = containerRef.current;
      if (!container) return;

      // Get all elements
      const circleSmallLocks = gsap.utils.toArray<HTMLDivElement>(".circle-small-lock");
      const circleSmallIcon = container.querySelector<HTMLDivElement>(".circle-small-icon");
      const circleMediumLocks = gsap.utils.toArray<HTMLDivElement>(".circle-medium-lock");
      const circleMediumIcon = container.querySelector<HTMLDivElement>(".circle-medium-icon");
      const circleBigLocks = gsap.utils.toArray<HTMLDivElement>(".circle-big-lock");
      const circleBigIcon = container.querySelector<HTMLDivElement>(".circle-big-icon");

      const bigPath = container.querySelector<SVGPathElement>("#circle-path-big");
      const mediumPath = container.querySelector<SVGPathElement>("#circle-path-medium");
      const smallPath = container.querySelector<SVGPathElement>("#circle-path-small");

      if (!bigPath || !mediumPath || !smallPath) return;

      // Setup motion paths
      setupMotionPath(circleSmallLocks, smallPath, "even");
      if (circleSmallIcon) setupMotionPath([circleSmallIcon], smallPath, [ICON_POSITIONS.small]);

      setupMotionPath(circleMediumLocks, mediumPath, "even");
      if (circleMediumIcon) setupMotionPath([circleMediumIcon], mediumPath, [ICON_POSITIONS.medium]);

      setupMotionPath(circleBigLocks, bigPath, "even");
      if (circleBigIcon) setupMotionPath([circleBigIcon], bigPath, [ICON_POSITIONS.big]);

      // Create timeline
      const tl = createAnimationTimeline();

      // Event handlers
      const handleMouseEnter = () => tl.timeScale(1).play();
      const handleMouseLeave = () => tl.timeScale(1.5).reverse();

      container.addEventListener("mouseenter", handleMouseEnter);
      container.addEventListener("mouseleave", handleMouseLeave);

      return () => {
        container.removeEventListener("mouseenter", handleMouseEnter);
        container.removeEventListener("mouseleave", handleMouseLeave);
      };
    },
    { scope: containerRef },
  );

  return (
    <div
      ref={containerRef}
      className="p-lg bg-background-muted relative z-0 h-full w-full gap-4 overflow-hidden rounded-sm"
    >
      <DotsPattern />

      {/* Header */}
      <div className="feature-header text-primary relative z-10 flex w-full flex-col gap-2 text-center">
        <h3 className="h3-serif mx-auto w-fit">Multi-provider orchestration</h3>
        <p className="body-base-sm text-balance text-inherit">
          Pick the right model per task — Anthropic for reasoning, Groq for speed, a local model for sensitive data.
          OpenWork composes them through OpenCode without bespoke glue.
        </p>
      </div>

      {/* Center Logo */}
      <div className="border-primary bg-background-muted absolute bottom-0 left-1/2 z-10 aspect-square w-[28.8rem] -translate-x-1/2 translate-y-1/2 rounded-full border border-dashed p-2">
        <div className="bg-primary-dark relative z-0 h-full w-full overflow-hidden rounded-full">
          <div className="absolute top-[4.8rem] left-1/2 -translate-x-1/2">
            <LogoSymbolIcon className="w-[8rem] text-white" />
          </div>
        </div>
      </div>

      {/* Pulse Line */}
      <div className="bg-primary/5 border-primary pulse absolute bottom-0 left-1/2 h-0 w-[1px] -translate-x-1/2 border-x"></div>

      {/* Small Circle Path */}
      <div className="circle-small-wrapper absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2">
        <CirclePath
          id="circle-path-small"
          className="w-[46.4rem]"
          viewBox="0 0 464 464"
          d="M232 0.5C359.854 0.5 463.5 104.146 463.5 232C463.5 359.854 359.854 463.5 232 463.5C104.146 463.5 0.5 359.854 0.5 232C0.5 104.146 104.146 0.5 232 0.5Z"
        />

        {[...Array(8)].map((_, i) => (
          <CircleNode key={i} className="circle-small-lock">
            <LockIcon className="w-[2.4rem]" />
          </CircleNode>
        ))}

        <IconCircle className="circle-small-icon" icon={<NotionIcon className="w-[2.4rem]" />} />
      </div>

      {/* Medium Circle Path */}
      <div className="circle-medium-wrapper absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2">
        <CirclePath
          id="circle-path-medium"
          className="w-[60.5rem]"
          viewBox="0 0 605 605"
          d="M136.706 49.9053C275.953 -41.4028 462.855 -2.54069 554.163 136.706C645.471 275.953 606.609 462.855 467.362 554.163C328.116 645.471 141.213 606.609 49.9053 467.362C-41.4028 328.116 -2.54067 141.213 136.706 49.9053Z"
        />

        {[...Array(8)].map((_, i) => (
          <CircleNode key={i} className="circle-medium-lock">
            <LockIcon className="w-[2.4rem]" />
          </CircleNode>
        ))}

        <IconCircle className="circle-medium-icon" icon={<SlackIcon className="w-[2.4rem]" />} />
      </div>

      {/* Big Circle Path */}
      <div className="circle-big-wrapper absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2">
        <CirclePath
          id="circle-path-big"
          className="w-[74.5rem]"
          viewBox="0 0 745 745"
          d="M214.974 35.4482C400.895 -51.324 621.957 29.052 708.729 214.974C795.502 400.895 715.126 621.957 529.204 708.729C343.283 795.502 122.221 715.125 35.4482 529.204C-51.324 343.283 29.0521 122.221 214.974 35.4482Z"
        />

        {[...Array(8)].map((_, i) => (
          <CircleNode key={i} className="circle-big-lock">
            <LockIcon className="w-[2.4rem]" />
          </CircleNode>
        ))}

        <IconCircle className="circle-big-icon" icon={<GmailIcon className="w-[2.4rem]" />} />
      </div>
    </div>
  );
};

export default FeatureOrchestration;
