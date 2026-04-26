"use client";
import { useRef } from "react";
import DotsPattern from "../dots-pattern";
import LockIcon from "@/icons/ui/lock-icon";
import WarningIcon from "@/icons/ui/warning-icon";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import MotionPathPlugin from "gsap/MotionPathPlugin";
import { CircleCheck } from "lucide-react";

gsap.registerPlugin(MotionPathPlugin);

// Configuration constants
const ANIMATION_CONFIG = {
  ease: "primary",
  duration: 1,
  pulseDuration: 1.435,
  colorTransitionDuration: 0.3,
  strokeTransitionDuration: 0.3,
  offset: 0.05,
} as const;

const CIRCLE_POSITIONS = {
  small: [0.1],
  medium: [0.3, 0.7],
  big: [0.8, 0.4],
} as const;

const PATH_IDS = {
  small: "#circle-small-path",
  medium: "#circle-medium-path",
  big: "#circle-big-path",
} as const;

interface CircleNodeProps {
  className: string;
  dangerClassName?: string;
}

interface CirclePathProps {
  id: string;
  viewBox: string;
  d: string;
  strokeWidth?: string;
  className: string;
}

interface AnimationPaths {
  small: SVGPathElement;
  medium: SVGPathElement;
  big: SVGPathElement;
}

// Reusable CircleNode component
const CircleNode = ({ className, dangerClassName = "danger-big" }: CircleNodeProps) => (
  <div
    className={`border-primary bg-background-muted ${className} absolute grid size-[4rem] place-content-center rounded-full border border-dashed`}
  >
    <div
      className={`${dangerClassName} absolute inset-0 z-0 grid h-full w-full scale-0 place-content-center rounded-full`}
    >
      <div className="danger-pulse absolute top-1/2 left-1/2 -z-10 h-full w-full -translate-x-1/2 -translate-y-1/2 scale-0 animate-pulse rounded-full border border-green-500 bg-green-500/40"></div>
      <div className="absolute inset-0 -z-10 h-full w-full scale-150 rounded-full border border-dashed border-white p-[1px]">
        <div className="h-full w-full rounded-full bg-green-500"></div>
      </div>
      <CircleCheck className="scale-125 text-white" />
    </div>
    <WarningIcon />
  </div>
);

// SVG Circle component
const CirclePath = ({ id, viewBox, d, strokeWidth = "1", className }: CirclePathProps) => (
  <svg className={className} viewBox={viewBox} fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d={d} className="stroke-primary" strokeWidth={strokeWidth} id={id} />
  </svg>
);

const FeatureSecurity = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  const setupMotionPath = (circles: HTMLDivElement[], path: SVGPathElement, positions: readonly number[]): void => {
    circles.forEach((circle, index) => {
      const progress = positions[index];
      if (progress !== undefined) {
        gsap.set(circle, {
          motionPath: {
            path,
            align: path,
            alignOrigin: [0.5, 0.5],
            start: progress,
            end: progress,
          },
        });
      }
    });
  };

  const createAnimationTimeline = (paths: AnimationPaths): gsap.core.Timeline => {
    const tl = gsap.timeline({
      paused: true,
      defaults: {
        ease: ANIMATION_CONFIG.ease,
        duration: ANIMATION_CONFIG.duration,
      },
    });

    // Initial pulse animation
    tl.to(".pulse", {
      scale: 1,
      duration: ANIMATION_CONFIG.pulseDuration,
    });

    // Lock icon color change
    tl.to(
      ".lock-icon",
      {
        color: "var(--color-green-500)",
        ease: "none",
        duration: ANIMATION_CONFIG.colorTransitionDuration,
      },
      "<+=0.25",
    );

    // Small circle animations
    tl.to(
      paths.small,
      {
        stroke: "var(--color-green-500)",
        ease: "none",
        duration: ANIMATION_CONFIG.strokeTransitionDuration,
      },
      "<",
    );

    tl.to(
      ".circle-small",
      {
        rotate: "1080deg",
        ease: "back.inOut",
      },
      `<+=${ANIMATION_CONFIG.offset}`,
    );

    tl.to(
      ".danger-small",
      {
        scale: 1,
        rotation: "360deg",
        ease: "back.inOut",
      },
      `<+=${ANIMATION_CONFIG.offset}`,
    );

    // Medium circle animations
    tl.to(
      paths.medium,
      {
        stroke: "var(--color-green-500)",
        ease: "none",
        duration: ANIMATION_CONFIG.strokeTransitionDuration,
      },
      "<",
    );

    tl.to(
      ".circle-medium",
      {
        rotation: "1080deg",
        ease: "back.inOut",
      },
      `<+=${ANIMATION_CONFIG.offset}`,
    );

    tl.to(
      ".danger-medium",
      {
        scale: 1,
        rotation: "360deg",
        ease: "back.inOut",
      },
      `<+=${ANIMATION_CONFIG.offset}`,
    );

    tl.to(
      ".danger-small .danger-pulse",
      {
        scale: 1.85,
      },
      `<+=${ANIMATION_CONFIG.offset}`,
    );

    tl.to(
      ".feature-header",
      {
        color: "var(--color-green-600)",
        ease: "none",
        duration: ANIMATION_CONFIG.colorTransitionDuration,
      },
      "<",
    );

    // Big circle animations
    tl.to(
      paths.big,
      {
        stroke: "var(--color-green-500)",
        ease: "none",
        duration: ANIMATION_CONFIG.strokeTransitionDuration,
      },
      "<",
    );

    tl.to(
      ".circle-big",
      {
        rotation: "1080deg",
        ease: "back.inOut",
      },
      `<+=${ANIMATION_CONFIG.offset}`,
    );

    tl.to(
      ".danger-big",
      {
        scale: 1,
        rotation: "360deg",
        ease: "back.inOut",
      },
      `<+=${ANIMATION_CONFIG.offset}`,
    );

    tl.to(
      ".danger-big .danger-pulse",
      {
        scale: 1.85,
      },
      `<+=${ANIMATION_CONFIG.offset}`,
    );

    return tl;
  };

  useGSAP(
    () => {
      const circleSmallCircles = gsap.utils.toArray<HTMLDivElement>(".circle-small");
      const circleMediumCircles = gsap.utils.toArray<HTMLDivElement>(".circle-medium");
      const circleBigCircles = gsap.utils.toArray<HTMLDivElement>(".circle-big");

      const bigPath = containerRef.current?.querySelector<SVGPathElement>(PATH_IDS.big);
      const mediumPath = containerRef.current?.querySelector<SVGPathElement>(PATH_IDS.medium);
      const smallPath = containerRef.current?.querySelector<SVGPathElement>(PATH_IDS.small);

      if (!bigPath || !mediumPath || !smallPath) return;

      // Setup motion paths
      setupMotionPath(circleSmallCircles, smallPath, CIRCLE_POSITIONS.small);
      setupMotionPath(circleMediumCircles, mediumPath, CIRCLE_POSITIONS.medium);
      setupMotionPath(circleBigCircles, bigPath, CIRCLE_POSITIONS.big);

      // Create and setup animation timeline
      const tl = createAnimationTimeline({ small: smallPath, medium: mediumPath, big: bigPath });

      // Event listeners
      const container = containerRef.current;
      if (container) {
        const handleMouseEnter = () => tl.timeScale(1).play();
        const handleMouseLeave = () => tl.timeScale(1.5).reverse();

        container.addEventListener("mouseenter", handleMouseEnter);
        container.addEventListener("mouseleave", handleMouseLeave);

        // Cleanup function
        return () => {
          container.removeEventListener("mouseenter", handleMouseEnter);
          container.removeEventListener("mouseleave", handleMouseLeave);
        };
      }
    },
    { scope: containerRef },
  );

  return (
    <div
      ref={containerRef}
      className="bg-background-muted p-lg gap-base relative z-0 flex h-full w-full flex-col overflow-hidden rounded-sm"
    >
      <DotsPattern />
      <div className="relative z-0 w-full grow">
        <div className="pulse absolute top-1/2 left-1/2 -z-10 aspect-square w-[300%] -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full border-4 border-green-500 bg-green-500/5 mix-blend-color will-change-transform"></div>

        <div className="absolute top-0 left-1/2 z-0 grid h-full w-full -translate-x-1/2 place-content-center">
          {/* Big circle layer */}
          <div className="relative w-full">
            <CirclePath
              id="circle-big-path"
              className="w-[37.7rem]"
              viewBox="0 0 377 377"
              d="M188.5 0.5C292.33 0.5 376.5 84.6705 376.5 188.5C376.5 292.33 292.33 376.5 188.5 376.5C84.6705 376.5 0.5 292.33 0.5 188.5C0.5 84.6705 84.6705 0.5 188.5 0.5Z"
            />
            <CircleNode className="circle-big" />
            <CircleNode className="circle-big" />
          </div>

          {/* Medium circle layer */}
          <div className="absolute top-1/2 left-1/2 w-[29.3rem] -translate-x-1/2 -translate-y-1/2">
            <CirclePath
              id="circle-medium-path"
              className="w-[29.3rem]"
              viewBox="0 0 293 293"
              d="M146.5 0.388672C227.195 0.388672 292.611 65.8049 292.611 146.5C292.611 227.195 227.195 292.611 146.5 292.611C65.8049 292.611 0.388672 227.195 0.388672 146.5C0.388672 65.8049 65.8049 0.388672 146.5 0.388672Z"
            />
            <CircleNode className="circle-medium" dangerClassName="danger-medium" />
            <CircleNode className="circle-medium" dangerClassName="danger-medium" />
          </div>

          {/* Small circle layer */}
          <div className="absolute top-1/2 left-1/2 grid w-[20.3rem] -translate-x-1/2 -translate-y-1/2 place-content-center">
            <CirclePath
              id="circle-small-path"
              className="w-[20.3rem]"
              viewBox="0 0 203 203"
              d="M101.5 0.5C157.281 0.5 202.5 45.7192 202.5 101.5C202.5 157.281 157.281 202.5 101.5 202.5C45.7192 202.5 0.5 157.281 0.5 101.5C0.5 45.7192 45.7192 0.5 101.5 0.5Z"
            />
            <div className="absolute top-1/2 left-1/2 z-0 -translate-x-1/2 -translate-y-1/2">
              <LockIcon className="lock-icon w-[6rem]" />
            </div>
            <CircleNode className="circle-small top-0" dangerClassName="danger-small" />
          </div>
        </div>
      </div>

      <div className="gap-sm feature-header text-primary flex w-full flex-col text-center">
        <h3 className="h3-serif">Permission-gated by design</h3>
        <p className="body-base-sm text-balance text-inherit">
          Folders are explicitly authorized. Credentials live in your OS keychain. Every tool call surfaces an
          allow / always / deny prompt. Audit logs are exportable. Local-first by default.
        </p>
      </div>
    </div>
  );
};

export default FeatureSecurity;
