import { json } from "@codemirror/lang-json";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import { createShadcnEditorTheme } from "./codemirror-theme";

const diffTheme = EditorView.theme({
  "&.cm-merge-b .cm-changedLine, .cm-insertedLine, .cm-inlineChangedLine": {
    backgroundColor: "color-mix(in oklch, var(--primary) 10%, transparent)",
  },
  ".cm-deletedChunk": {
    backgroundColor: "color-mix(in oklch, var(--destructive) 10%, transparent)",
  },
  "&.cm-merge-b .cm-changedText": {
    backgroundColor: "color-mix(in oklch, var(--primary) 20%, transparent)",
    backgroundImage: "none",
  },
  ".cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText": {
    backgroundColor: "color-mix(in oklch, var(--destructive) 20%, transparent)",
    backgroundImage: "none",
  },
  "&.cm-merge-b .cm-changedLineGutter": { backgroundColor: "var(--muted)" },
  ".cm-deletedLineGutter": { backgroundColor: "var(--destructive)" },
  ".cm-insertedLineGutter": { backgroundColor: "var(--primary)" },
  ".cm-collapsedLines": {
    color: "var(--muted-foreground)",
    background: "var(--muted)",
  },
});

export function SpecDiff({
  original,
  modified,
}: {
  original: string;
  modified: string;
}) {
  const extensions = useMemo(
    () => [
      json(),
      createShadcnEditorTheme(),
      diffTheme,
      EditorState.readOnly.of(true),
      EditorView.contentAttributes.of({
        "aria-label": "Published version compared with saved draft",
      }),
      unifiedMergeView({
        original,
        mergeControls: false,
        diffConfig: { scanLimit: 500, timeout: 100 },
        collapseUnchanged: { margin: 3, minSize: 8 },
      }),
    ],
    [original],
  );
  return (
    <CodeMirror
      value={modified}
      extensions={extensions}
      editable={false}
      theme="none"
      height="28rem"
      className="overflow-hidden rounded-md border text-xs"
    />
  );
}
