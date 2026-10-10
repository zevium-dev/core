import { api } from "#/lib/convex-api";
import { humanError } from "#/lib/human-error";
import { applyPricingEdit, type PricingEdit } from "#/lib/spec-pricing-edit";
import { useConvexMutation } from "@convex-dev/react-query";
import { useMutation } from "@tanstack/react-query";
import { collectOpenApiSpecIssues, type SpecIssue } from "@zevium/shared";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { toast } from "sonner";
import type { SpecWorkspaceProps } from "./spec-workspace";
import { OPENAPI_TEMPLATE } from "./template";

type Snapshot = { text: string; hash: string | null; savedAt: number | null };
type State = {
  text: string;
  base: Snapshot;
  conflict: Snapshot | null;
  serverIssues: SpecIssue[];
  failures: number;
};
type Action =
  | { type: "edit"; text: string }
  | { type: "remote" | "saved" | "reload" | "conflict"; snapshot: Snapshot }
  | { type: "issues"; issues: SpecIssue[] }
  | { type: "failed" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "edit":
      return { ...state, text: action.text, serverIssues: [], failures: 0 };
    case "remote":
      // Never advance the base beneath local edits. Ignore older subscription
      // snapshots arriving after a mutation's canonical response.
      if (
        state.text !== state.base.text ||
        state.conflict ||
        (action.snapshot.hash !== state.base.hash &&
          (action.snapshot.savedAt ?? 0) <= (state.base.savedAt ?? 0))
      )
        return state;
      return { ...state, text: action.snapshot.text, base: action.snapshot };
    case "saved":
      return { ...state, base: action.snapshot, conflict: null, failures: 0 };
    case "reload":
      return {
        text: action.snapshot.text,
        base: action.snapshot,
        conflict: null,
        serverIssues: [],
        failures: 0,
      };
    case "conflict":
      return { ...state, conflict: action.snapshot };
    case "issues":
      return { ...state, serverIssues: action.issues };
    case "failed":
      return { ...state, failures: state.failures + 1 };
  }
}

function mergeIssues(client: SpecIssue[], server: SpecIssue[]): SpecIssue[] {
  const key = (issue: SpecIssue) =>
    `${issue.level}|${issue.path}|${issue.message}`;
  const seen = new Set(client.map(key));
  return [...client, ...server.filter((issue) => !seen.has(key(issue)))];
}

export function useSpecDraft({
  projectId,
  savedDraft,
  savedDraftHash,
  lastSavedAt,
}: Pick<
  SpecWorkspaceProps,
  "projectId" | "savedDraft" | "savedDraftHash" | "lastSavedAt"
>) {
  const [state, dispatch] = useReducer(reducer, {
    text: savedDraft.trim() === "" ? OPENAPI_TEMPLATE : savedDraft,
    base: { text: savedDraft, hash: savedDraftHash, savedAt: lastSavedAt },
    conflict: null,
    serverIssues: [],
    failures: 0,
  });
  // Event handlers need the latest text even when several rail edits are
  // flushed in the same React batch.
  const textRef = useRef(state.text);
  textRef.current = state.text;
  const edit = useCallback((text: string) => {
    textRef.current = text;
    dispatch({ type: "edit", text });
  }, []);
  const clientIssues = useMemo(
    () =>
      state.text.trim() === "" ? [] : collectOpenApiSpecIssues(state.text),
    [state.text],
  );
  const hasClientErrors = clientIssues.some((issue) => issue.level === "error");
  const dirty = state.text !== state.base.text || state.conflict !== null;
  const saveDraft = useConvexMutation(api.specs.saveDraft);
  const mutation = useMutation({
    mutationFn: (input: { spec: string; baseHash: string | null }) =>
      saveDraft({ projectId, ...input }),
    onSuccess: (result, input) => {
      const snapshot = {
        text: result.draft,
        hash: result.draftHash ?? null,
        savedAt: result.lastSavedAt,
      };
      if (result.conflict) {
        dispatch({ type: "conflict", snapshot });
        return;
      }
      if (!result.ok) {
        dispatch({ type: "issues", issues: result.issues });
        dispatch({ type: "failed" });
        toast.error("Draft has errors — fix issues before saving");
        return;
      }
      dispatch({ type: "saved", snapshot });
      if (textRef.current === input.spec)
        dispatch({ type: "issues", issues: result.issues });
    },
    onError: (error: unknown) => {
      dispatch({ type: "failed" });
      toast.error(humanError(error, "Could not save draft"));
    },
  });
  useEffect(() => {
    if (!mutation.isPending)
      dispatch({
        type: "remote",
        snapshot: {
          text: savedDraft,
          hash: savedDraftHash,
          savedAt: lastSavedAt,
        },
      });
  }, [savedDraft, savedDraftHash, lastSavedAt, mutation.isPending]);
  const { mutate, mutateAsync, isPending } = mutation;
  useEffect(() => {
    if (
      !dirty ||
      hasClientErrors ||
      isPending ||
      state.conflict ||
      state.failures >= 3
    )
      return;
    const timer = setTimeout(
      () => mutate({ spec: state.text, baseHash: state.base.hash }),
      2000,
    );
    return () => clearTimeout(timer);
  }, [
    dirty,
    hasClientErrors,
    isPending,
    state.text,
    state.base.hash,
    state.conflict,
    state.failures,
    mutate,
  ]);
  const latestRemote =
    state.conflict && (state.conflict.savedAt ?? 0) > (lastSavedAt ?? 0)
      ? state.conflict
      : { text: savedDraft, hash: savedDraftHash, savedAt: lastSavedAt };
  return {
    text: state.text,
    dirty,
    hasClientErrors,
    savePending: isPending,
    confirmedDraft: state.base.text,
    confirmedDraftHash: state.base.hash,
    lastSavedAt: state.base.savedAt,
    conflict: state.conflict,
    autosaveTripped: state.failures >= 3,
    issues: mergeIssues(clientIssues, state.serverIssues),
    edit,
    setServerIssues: (issues: SpecIssue[]) =>
      dispatch({ type: "issues", issues }),
    save: () => {
      if (!isPending && !state.conflict)
        mutate({ spec: textRef.current, baseHash: state.base.hash });
    },
    saveAsync: async () => {
      if (isPending || state.conflict || hasClientErrors) return false;
      try {
        const spec = textRef.current;
        const result = await mutateAsync({ spec, baseHash: state.base.hash });
        return result.ok && textRef.current === spec;
      } catch {
        return false;
      }
    },
    reload: () => dispatch({ type: "reload", snapshot: latestRemote }),
    overwrite: () => {
      if (!isPending)
        mutate({ spec: textRef.current, baseHash: latestRemote.hash });
    },
    applyPricingChange: (change: PricingEdit) => {
      const result = applyPricingEdit(textRef.current, change);
      if (result.ok) edit(result.text);
      else
        toast.error(
          "Pricing could not be applied. Fix the spec or restore the endpoint, then retry.",
        );
    },
  };
}
