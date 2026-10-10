import { CopyButton } from "#/components/copy-button";

import { SyntaxCode } from "#/components/syntax-code";
import { cn } from "#/lib/utils";

type DocsCodeBlockProps = {
  code: string;
  lang?: string;
  className?: string;
  copyLabel?: string;
};

/**
 * Code block with copy button for in-app docs.
 * `not-prose` escapes @tailwindcss/typography so the <pre> keeps its own
 * semantic-token styling. All colors are semantic tokens (.agents/notes/design/design-system.md).
 */
export function DocsCodeBlock({
  code,
  lang,
  className,
  copyLabel = "Copy code",
}: DocsCodeBlockProps) {
  return (
    <div
      className={cn(
        "not-prose group relative my-5 overflow-hidden rounded-lg border bg-muted/40",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b bg-muted/60 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-foreground">
          {lang ?? "code"}
        </span>
        <CopyButton text={code} variant="ghost" aria-label={copyLabel} />
      </div>
      <pre
        tabIndex={0}
        role="region"
        aria-label={`${lang ?? "Code"} example`}
        className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
      >
        <SyntaxCode code={code} lang={lang} />
      </pre>
    </div>
  );
}
