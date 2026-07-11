import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

type DocsCodeBlockProps = {
  code: string;
  /** Display-only language label (no syntax highlighting — keeps bundle lean). */
  lang?: string;
  className?: string;
};

/**
 * Code block with copy button for in-app docs.
 * `not-prose` escapes @tailwindcss/typography so the <pre> keeps its own
 * semantic-token styling. All colors are semantic tokens (DESIGN.md).
 */
export function DocsCodeBlock({ code, lang, className }: DocsCodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Copied");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — select and copy manually");
    }
  }

  return (
    <div
      className={cn(
        "not-prose group relative my-5 overflow-hidden rounded-lg border bg-muted/40",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b bg-muted/60 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {lang ?? "code"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          onClick={() => void onCopy()}
          aria-label="Copy code"
        >
          {copied ? (
            <Check className="size-3.5 text-foreground" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}
