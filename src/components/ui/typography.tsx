import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "~/lib/utils/index";

const defaultComponents = {
  blockquote: "blockquote",
  code: "code",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  large: "div",
  lead: "p",
  muted: "p",
  p: "p",
  small: "small",
  td: "td",
  th: "th",
  ul: "ul",
};

const typographyVariants = cva("", {
  defaultVariants: {
    variant: "p",
  },
  variants: {
    variant: {
      blockquote: "mt-6 border-l-2 pl-6 italic",
      code: "bg-muted relative rounded px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold",
      h1: "scroll-m-20 text-center text-4xl font-extrabold tracking-tight text-balance",
      h2: "scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0",
      h3: "scroll-m-20 text-2xl font-semibold tracking-tight",
      h4: "scroll-m-20 text-xl font-semibold tracking-tight",
      large: "text-lg font-semibold",
      lead: "text-muted-foreground text-xl",
      muted: "text-muted-foreground text-sm",
      p: "leading-7 [&:not(:first-child)]:mt-6",
      small: "text-sm leading-none font-medium",
      td: "border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right",
      th: "border px-4 py-2 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right",
      ul: "my-6 ml-6 list-disc [&>li]:mt-2",
    },
  },
});

function Typography({
  asChild = false,
  className,
  variant,
  ...props
}: {
  asChild?: boolean;
  loading?: boolean;
} & React.ComponentProps<"p"> &
  VariantProps<typeof typographyVariants>) {
  const Comp = asChild ? Slot : defaultComponents[variant ?? "p"];

  return <Comp className={cn(typographyVariants({ className, variant }))} data-slot="p" {...props} />;
}

export { Typography, typographyVariants };
