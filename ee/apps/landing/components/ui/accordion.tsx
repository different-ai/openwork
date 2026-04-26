"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import * as AccordionPrimitive from "@radix-ui/react-accordion";

function Accordion({ ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

function AccordionItem({ className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return <AccordionPrimitive.Item data-slot="accordion-item" className={cn(className)} {...props} />;
}

function AccordionTrigger({ className, children, ...props }: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "focus-visible:border-ring focus-visible:ring-ring/50 group text-base-lg relative mb-[1.6rem] flex flex-1 cursor-pointer items-start justify-between rounded-full text-left font-sans leading-none font-medium transition-all outline-none hover:underline focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 sm:text-lg [&[data-state=open]>svg]:rotate-180",
          className,
        )}
        {...props}
      >
        <div className="bg-primary p-base ease-primary absolute z-0 grid aspect-square h-full shrink-0 origin-left place-content-center rounded-full duration-700 group-data-[state=closed]:scale-0 group-data-[state=closed]:rotate-45">
          <div className="h-[4px] w-[2rem] bg-white"></div>
        </div>
        <div className="bg-background-muted py-base px-xl ease-primary grid h-[7rem] grow origin-right items-center rounded-full duration-700 group-data-[state=open]:translate-x-[7rem]">
          {children}
        </div>
        <div className="bg-primary p-base ease-primary relative z-0 grid aspect-square h-full shrink-0 origin-right place-content-center rounded-full duration-700 group-data-[state=open]:scale-0 group-data-[state=open]:rotate-45">
          <div className="h-[4px] w-[2rem] bg-white"></div>
          <div className="absolute top-1/2 left-1/2 h-[4px] w-[2rem] -translate-1/2 rotate-90 bg-white"></div>
        </div>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({ className, children, ...props }: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="data-[state=closed]:animate-accordion-up text-base-sm data-[state=open]:animate-accordion-down overflow-hidden pl-[3.2rem] font-sans font-medium"
      {...props}
    >
      <div className={cn("pt-0 pb-4", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
