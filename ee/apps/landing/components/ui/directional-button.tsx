"use client";

import { ReactNode } from "react";
import { Button, ButtonProps } from "./button";
import { cn } from "@/lib/utils";
import { useGSAP } from "@gsap/react";
import { useMouse } from "@uidotdev/usehooks";
import gsap from "gsap";

type DirectionalButtonProps = ButtonProps & {
  children: ReactNode;
  className?: string;
  hoverColorClass?: string;
};

const DirectionalButton = ({ children, className, hoverColorClass, ...props }: DirectionalButtonProps) => {
  const [mouse, ref] = useMouse<HTMLDivElement>();
  const mousePosition = {
    x: mouse.elementX,
    y: mouse.elementY,
  };
  const { contextSafe } = useGSAP(() => { }, {
    scope: ref,
  });

  const handleMouseEnter = contextSafe(function() {
    gsap.set(".circle", {
      left: mousePosition.x,
      top: mousePosition.y,
    });
    gsap
      .timeline({
        defaults: {
          ease: "primary",
          duration: 0.7,
        },
      })
      .to(".primary", {
        y: "-100%",
      })
      .to(
        ".secondary",
        {
          y: "0",
        },
        "<",
      );
    gsap.to(".circle", {
      scale: 1,
    });
  });

  const handleMouseLeave = contextSafe(function() {
    gsap.set(".circle", {
      left: mousePosition.x,
      top: mousePosition.y,
    });
    gsap
      .timeline({
        defaults: {
          ease: "primary",
          duration: 0.7,
        },
      })
      .to(".primary", {
        y: "0",
      })
      .to(
        ".secondary",
        {
          y: "100%",
        },
        "<",
      );
    gsap.to(".circle", {
      scale: 0,
    });
  });

  return (
    <div ref={ref}>
      <Button
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={cn(
          "contact-link text-foreground border-foreground bg-background px-base-lg ease-primary hover:border-background relative z-0 grid place-content-center overflow-hidden rounded-full border border-dashed font-sans text-base font-medium duration-700",
          className,
        )}
        {...props}
      >
        <div>
          <div
            style={{
              background: `var(${hoverColorClass}) !important`,
            }}
            className={cn(
              "circle z-hidden bg-primary absolute top-1/2 left-1/2 aspect-square h-auto w-[280%] -translate-x-1/2 -translate-y-1/2 scale-0 rounded-[50%]",
            )}
          ></div>
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden text-white">
            <div className="secondary translate-y-full">{children}</div>
          </div>

          <div className="overflow-hidden">
            <div className="primary">{children}</div>
          </div>
        </div>
      </Button>
    </div>
  );
};

export default DirectionalButton;
