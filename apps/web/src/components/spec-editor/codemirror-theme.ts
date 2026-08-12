import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * CodeMirror theme from shadcn CSS vars — native light + dark.
 * Colors resolve at paint via var(); no hardcoded hex.
 */
export function createShadcnEditorTheme(): Extension {
  const base = EditorView.theme(
    {
      "&": {
        color: "var(--foreground)",
        backgroundColor: "var(--background)",
        fontSize: "0.75rem",
        fontFamily: "var(--font-mono)",
      },
      ".cm-content": {
        caretColor: "var(--foreground)",
        fontFamily: "var(--font-mono)",
        minHeight: "28rem",
        paddingTop: "0.75rem",
        paddingBottom: "0.75rem",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--foreground)",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor:
            "color-mix(in oklch, var(--primary) 25%, transparent)",
        },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in oklch, var(--muted) 55%, transparent)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--background)",
        color: "var(--muted-foreground)",
        border: "none",
        borderRight: "1px solid var(--border)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in oklch, var(--muted) 55%, transparent)",
        color: "var(--foreground)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 0.75rem 0 0.5rem",
        minWidth: "2.5rem",
      },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: "var(--font-mono)",
        lineHeight: "1.55",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
      },
      ".cm-tooltip-lint": {
        backgroundColor: "var(--popover)",
      },
      ".cm-diagnostic": {
        padding: "0.25rem 0.5rem",
      },
      ".cm-diagnostic-error": {
        borderLeftColor: "var(--destructive)",
      },
      ".cm-diagnostic-warning": {
        borderLeftColor: "var(--muted-foreground)",
      },
      ".cm-lintRange-error": {
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='M0 3 L3 0 L6 3' fill='none' stroke='%23ef4444' stroke-width='1'/%3E%3C/svg%3E\")",
      },
      ".cm-panels": {
        backgroundColor: "var(--card)",
        color: "var(--card-foreground)",
      },
      "&.cm-focused": {
        outline: "none",
      },
    },
    { dark: false },
  );

  const highlight = HighlightStyle.define([
    { tag: t.propertyName, color: "var(--foreground)" },
    { tag: t.string, color: "var(--primary)" },
    { tag: t.number, color: "var(--syntax-number)" },
    { tag: t.bool, color: "var(--syntax-number)" },
    { tag: t.null, color: "var(--muted-foreground)" },
    { tag: t.keyword, color: "var(--muted-foreground)" },
    { tag: t.punctuation, color: "var(--muted-foreground)" },
    { tag: t.bracket, color: "var(--muted-foreground)" },
    { tag: t.invalid, color: "var(--destructive)" },
    { tag: t.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  ]);

  return [base, syntaxHighlighting(highlight)];
}
