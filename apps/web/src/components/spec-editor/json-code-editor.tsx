import { json } from "@codemirror/lang-json";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { collectOpenApiSpecIssues, type SpecIssue } from "@zevium/shared";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { cn } from "#/lib/utils";

import { createShadcnEditorTheme } from "./codemirror-theme";

const LINT_DEBOUNCE_MS = 300;

const EditorViewMinHeight = EditorView.theme({
  "&": { minHeight: "28rem" },
  ".cm-scroller": { minHeight: "28rem" },
});

function issuesToDiagnostics(doc: string, issues: SpecIssue[]): Diagnostic[] {
  if (issues.length === 0) return [];
  const end = Math.max(doc.length, 0);
  return issues.map((issue) => ({
    from: 0,
    to: Math.min(end, Math.max(1, end)),
    severity: issue.level === "error" ? "error" : "warning",
    message: `${issue.message} (${issue.path})`,
  }));
}

export type JsonCodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
  editorRef?: RefObject<ReactCodeMirrorRef | null>;
};

export function JsonCodeEditor({
  value,
  onChange,
  placeholder,
  className,
  readOnly = false,
  editorRef,
}: JsonCodeEditorProps) {
  const [lintDoc, setLintDoc] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    clearTimeout(timerRef.current ?? undefined);
    timerRef.current = setTimeout(() => {
      setLintDoc(value);
      timerRef.current = null;
    }, LINT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timerRef.current ?? undefined);
    };
  }, [value]);

  const lintSource = useCallback(
    (view: { state: { doc: { toString(): string } } }) => {
      const text = view.state.doc.toString();
      const source = text === lintDoc || lintDoc === "" ? text : lintDoc;
      if (source.trim() === "") return [];
      const issues = collectOpenApiSpecIssues(source);
      return issuesToDiagnostics(source, issues);
    },
    [lintDoc],
  );

  const extensions: Extension[] = useMemo(
    () => [
      json(),
      lintGutter(),
      linter(lintSource, { delay: LINT_DEBOUNCE_MS }),
      createShadcnEditorTheme(),
      EditorViewMinHeight,
    ],
    [lintSource],
  );

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-input shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        className,
      )}
    >
      <CodeMirror
        ref={editorRef}
        value={value}
        height="28rem"
        theme="none"
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          searchKeymap: true,
        }}
        extensions={extensions}
        onChange={onChange}
        editable={!readOnly}
        placeholder={placeholder}
        className="text-xs"
      />
    </div>
  );
}
