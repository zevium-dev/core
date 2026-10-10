import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";

type CopyButtonProps = Omit<
  ComponentProps<typeof Button>,
  "onClick" | "children"
> & {
  text: string | (() => string);
  label?: string;
};

export function CopyButton({
  text,
  label = "Copy",
  variant = "outline",
  size = "sm",
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        typeof text === "function" ? text() : text,
      );
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed. Select and copy manually.");
    }
  }
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      {...props}
      onClick={() => void copy()}
    >
      {copied ? (
        <Check data-icon="inline-start" />
      ) : (
        <Copy data-icon="inline-start" />
      )}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}
