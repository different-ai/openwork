import * as React from "react";
import { Button } from "./button";
import type { ButtonProps } from "./button";
import NextLink from "./next-link";
import ArrowRightIcon from "@/icons/ui/arrow-right-icon";
import { cn } from "@/lib/utils";

type BaseProps = {
  variant?: "primary" | "secondary" | "tertiary";
  children: React.ReactNode;
};

type LinkProps = BaseProps & {
  isLink: true;
  href: string;
  target?: string;
};

type ActionButtonProps = Omit<ButtonProps, "variant" | "children" | "asChild"> &
  BaseProps & {
    isLink?: false;
  };

type BubbleButtonProps = LinkProps | ActionButtonProps;

const BubbleButton = (props: BubbleButtonProps) => {
  const { variant = "primary", children } = props;

  if (props.isLink) {
    const { href, target = "_self" } = props;
    return (
      <NextLink
        href={href}
        target={target}
        className="group relative z-0 flex h-[4rem] cursor-pointer items-stretch justify-center gap-0 bg-transparent font-sans text-base font-medium"
      >
        <ButtonInner variant={variant}>{children}</ButtonInner>
      </NextLink>
    );
  }

  const { isLink, variant: _variant, children: _children, className, ...buttonProps } = props;
  return (
    <Button
      {...(buttonProps as Omit<ButtonProps, "variant" | "children">)}
      className={cn(
        "group relative z-0 flex h-[4rem] cursor-pointer items-stretch justify-center gap-0 bg-transparent font-sans text-base font-medium",
        className,
      )}
    >
      <ButtonInner variant={variant}>{children}</ButtonInner>
    </Button>
  );
};

const ButtonInner = ({
  variant,
  children,
}: {
  variant: "primary" | "secondary" | "tertiary";
  children: React.ReactNode;
}) => {
  return (
    <div className="group relative z-0 flex h-[4rem]">
      <div
        className={cn(
          "bg-primary ease-primary grid aspect-square h-full origin-left scale-0 rotate-45 place-content-center rounded-full text-white duration-700 group-hover:scale-100 group-hover:rotate-0",
          variant === "secondary" && "bg-foreground-muted text-background",
          variant === "tertiary" && "bg-secondary text-black",
        )}
      >
        <ArrowRightIcon />
      </div>
      <div
        className={cn(
          "bg-foreground text-background px-base-lg ease-primary grid origin-right translate-x-[-4rem] place-content-center rounded-full leading-none duration-700 group-hover:translate-x-0",
          variant === "secondary" && "bg-background-muted text-foreground",
        )}
      >
        {children}
      </div>
      <div className="ease-primary absolute right-0 z-10 aspect-square h-full rotate-45 duration-700 group-hover:rotate-0">
        <div
          className={cn(
            "bg-background-muted ease-primary text-foreground grid aspect-square h-full origin-right place-content-center rounded-full duration-700 group-hover:scale-0",
            (variant === "secondary" || variant === "tertiary") && "bg-primary text-white",
          )}
        >
          <ArrowRightIcon />
        </div>
      </div>
    </div>
  );
};

export default BubbleButton;
