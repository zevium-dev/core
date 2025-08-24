import { Slot } from "@radix-ui/react-slot";
import * as React from "react";

import { cn } from "~/lib/utils/index";

export type MarkdownProps = { asChild?: boolean; html: string } & React.ComponentProps<"div">;

function Markdown({ asChild = false, className, html, ...props }: MarkdownProps) {
  const Comp = asChild ? Slot : "div";

  return (
    <Comp
      className={cn(
        "prose dark:prose-invert mx-auto max-w-[min(calc(100vw-32px),72ch)]",
        "prose-a:no-underline prose-a:hover:underline prose-a:break-all",
        "prose-img:rounded-xl",
        "prose-pre:mt-0 prose-pre:rounded-t-none",
        "prose-code:whitespace-pre prose-code:rounded prose-code:border-[#1e1e1e] prose-code:bg-[#1e1e1e] prose-code:p-0.5 prose-code:text-white prose-code:before:hidden prose-code:after:hidden",
        "defaults-for-unplugin-icons hide-quote-marks-inside-blockquote",
        "prose-img:my-1 prose-img:shadow-md prose-img:shadow-foreground/20 prose-a:inline-block prose-img:inline prose-hr:my-2 [&_summary]:cursor-pointer",
        "prose-img:hover:outline prose-img:outline-gray-500",
        "thin-scrollbar details-animated",
      )}
      // eslint-disable-next-line @eslint-react/dom/no-dangerously-set-innerhtml
      dangerouslySetInnerHTML={{ __html: html }}
      {...props}
    />
  );
}

export { Markdown };
