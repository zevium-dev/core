import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, Copy } from "lucide-react";
import * as React from "react";

import { useCopy } from "~/hooks/use-copy";
import { cn } from "~/lib/utils/index";

import { buttonVariants } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

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
      code: `
        relative rounded-sm bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm
        font-semibold
      `,
      h1: `
        scroll-m-20 text-center text-4xl font-extrabold tracking-tight
        text-balance
      `,
      h2: `
        scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight
        first:mt-0
      `,
      h3: "scroll-m-20 text-2xl font-semibold tracking-tight",
      h4: "scroll-m-20 text-xl font-semibold tracking-tight",
      large: "text-lg font-semibold",
      lead: "text-xl text-muted-foreground",
      muted: "text-sm text-muted-foreground",
      p: `
        leading-7
        not-first:mt-6
      `,
      small: "text-sm leading-none font-medium",
      td: `
        border px-4 py-2 text-left
        [[align=center]]:text-center
        [[align=right]]:text-right
      `,
      th: `
        border px-4 py-2 text-left font-bold
        [[align=center]]:text-center
        [[align=right]]:text-right
      `,
      ul: `
        my-6 ml-6 list-disc
        [&>li]:mt-2
      `,
    },
  },
});

type CopyTextProps = {
  buttonSize?: VariantProps<typeof buttonVariants>["size"];
  buttonVariant?: VariantProps<typeof buttonVariants>["variant"];
  children: React.ReactNode;
  copiedLabel?: string;
  copyLabel?: string;
  doneTimeout?: number;
  textClassName?: string;
  value?: string;
} & {
  ref?: React.Ref<HTMLButtonElement>;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> &
  VariantProps<typeof typographyVariants>;

function CopyText({
  buttonSize = "sm",
  buttonVariant = "ghost",
  children,
  className,
  copiedLabel = "Copied",
  copyLabel = "Copy",
  doneTimeout,
  onClick,
  ref,
  textClassName,
  value,
  variant,
  ...props
}: CopyTextProps) {
  const [copied, copy] = useCopy({ doneTimeout });

  const { disabled: disabledProp, ...buttonProps } = props;

  const textToCopy = React.useMemo(() => {
    if (typeof value === "string") return value;
    if (typeof children === "string" || typeof children === "number") return String(children);
    return null;
  }, [children, value]);

  const disabled = (disabledProp ?? false) || !textToCopy;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            buttonVariants({
              className: "group h-auto min-w-0 max-w-full items-center justify-start gap-2 text-left rounded-sm pt-0.5",
              size: buttonSize,
              variant: buttonVariant,
            }),
            className,
          )}
          data-slot="copy-text"
          disabled={disabled}
          onClick={(e) => {
            onClick?.(e);
            if (e.defaultPrevented || disabled || !textToCopy) return;
            copy(textToCopy);
          }}
          ref={ref}
          type="button"
          {...buttonProps}
        >
          <Typography asChild className={cn("min-w-0 flex-1 truncate", textClassName)} variant={variant}>
            <span>{children}</span>
          </Typography>
          {copied ? <Check aria-hidden="true" className="size-3" /> : <Copy aria-hidden="true" className="size-3" />}
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{copied ? copiedLabel : copyLabel}</TooltipContent>
    </Tooltip>
  );
}

function Typography({
  asChild = false,
  className,
  variant,
  ...props
}: {
  asChild?: boolean;
} & React.ComponentPropsWithoutRef<"p"> &
  VariantProps<typeof typographyVariants>) {
  const Comp = asChild ? Slot : defaultComponents[variant ?? "p"];

  return <Comp className={cn(typographyVariants({ className, variant }))} data-slot="p" {...props} />;
}

CopyText.displayName = "CopyText";

export { CopyText, Typography, typographyVariants };
