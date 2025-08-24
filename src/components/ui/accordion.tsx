import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "~/lib/utils/index";

function Accordion({ ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

function AccordionContent({ children, className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      className="rounded-b-base bg-secondary-background font-base data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm transition-all"
      data-slot="accordion-content"
      {...props}
    >
      <div className={cn("p-4", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}

function AccordionItem({ className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      className={cn("rounded-base border-border shadow-shadow overflow-hidden border-2 border-b", className)}
      data-slot="accordion-item"
      {...props}
    />
  );
}

function AccordionTrigger({ children, className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        className={cn(
          "text-main-foreground border-border bg-main font-heading flex flex-1 items-center justify-between p-4 text-left text-base transition-all focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 data-[state=open]:rounded-b-none data-[state=open]:border-b-2 [&[data-state=open]>svg]:rotate-180",
          className,
        )}
        data-slot="accordion-trigger"
        {...props}
      >
        {children}
        <ChevronDown className="pointer-events-none size-5 shrink-0 transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
