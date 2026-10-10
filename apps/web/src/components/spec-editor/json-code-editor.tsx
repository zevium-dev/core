import { json, jsonLanguage, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { collectOpenApiSpecIssues } from "@zevium/shared";
import { useMemo, type RefObject } from "react";

import { cn } from "#/lib/utils";

import { createShadcnEditorTheme } from "./codemirror-theme";

const LINT_DEBOUNCE_MS = 300;

const EditorViewMinHeight = EditorView.theme({
  "&": { minHeight: "28rem" },
  ".cm-scroller": { minHeight: "28rem" },
});

const syntaxLint = jsonParseLinter();
function specLint(view: EditorView): Diagnostic[] {
  const doc = view.state.doc.toString();
  if (doc.trim() === "") return [];
  const syntaxIssues = syntaxLint(view);
  if (syntaxIssues.length) return syntaxIssues;
  const ranges = new Map<string, { from: number; to: number }>();
  type Node = ReturnType<typeof jsonLanguage.parser.parse>["topNode"];
  function visit(node: Node, path: string) {
    ranges.set(path, { from: node.from, to: node.to });
    if (node.name === "Object") {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== "Property") continue;
        const name = child.firstChild;
        const value = child.lastChild;
        if (!name || !value) continue;
        const key = JSON.parse(doc.slice(name.from, name.to)) as string;
        visit(
          value,
          path === "$.paths" ? `${path}["${key}"]` : `${path}.${key}`,
        );
      }
    } else if (node.name === "Array") {
      let index = 0;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "[" || child.name === "]" || child.name === ",")
          continue;
        visit(child, `${path}[${index++}]`);
      }
    }
  }
  const root = jsonLanguage.parser.parse(doc).topNode.firstChild;
  if (root) visit(root, "$");
  return collectOpenApiSpecIssues(doc).map((issue) => {
    let path = issue.path;
    while (!ranges.has(path) && path !== "$") {
      path = path.replace(/(?:\.[^.[\]]+|\[[^\]]*\])$/, "");
      if (!path) break;
    }
    const range = ranges.get(path);
    return {
      ...(range ?? { from: 0, to: Math.min(1, doc.length) }),
      severity: issue.level === "error" ? "error" : "warning",
      message: `${issue.message} (${issue.path})`,
    };
  });
}

export type JsonCodeEditorProps = {
  value: string;
  onChange?: (value: string) => void;
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
  const extensions: Extension[] = useMemo(
    () => [
      json(),
      lintGutter(),
      linter(specLint, { delay: LINT_DEBOUNCE_MS }),
      createShadcnEditorTheme(),
      EditorViewMinHeight,
      EditorView.contentAttributes.of({
        "aria-label": readOnly
          ? "Published OpenAPI specification"
          : "OpenAPI specification",
      }),
    ],
    [readOnly],
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
