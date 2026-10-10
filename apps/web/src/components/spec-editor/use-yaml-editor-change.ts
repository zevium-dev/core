import { convertSpecInputToJson } from "#/lib/spec-yaml";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

/** Revision guards discard conversions from an earlier paste or replacement. */
export function useYamlEditorChange(edit: (text: string) => void) {
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      revision.current += 1;
    },
    [],
  );
  const onChange = useCallback(
    (text: string) => {
      const current = ++revision.current;
      clearTimeout(timer.current);
      edit(text);
      if (text.trim() === "" || /^[{[]/.test(text.trimStart())) return;
      timer.current = setTimeout(() => {
        void convertSpecInputToJson(text).then((result) => {
          if (
            current !== revision.current ||
            !result.ok ||
            !result.convertedFromYaml
          )
            return;
          edit(result.json);
          toast.success("Converted YAML to JSON");
        });
      }, 150);
    },
    [edit],
  );
  return {
    onChange,
    cancel: () => {
      revision.current += 1;
      clearTimeout(timer.current);
    },
  };
}
