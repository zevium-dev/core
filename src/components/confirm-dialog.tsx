import {
  createContext,
  type PropsWithChildren,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

export interface ConfirmOptions {
  cancelText?: ReactNode;
  confirmText?: ReactNode;
  description: ReactNode;
  destructive?: boolean;
  title?: ReactNode;
}

type ConfirmAction =
  | {
      request: ConfirmRequest;
      type: "enqueue";
    }
  | {
      type: "dequeue";
    };

interface ConfirmRequest {
  id: number;
  options: {
    cancelText: ReactNode;
    confirmText: ReactNode;
    description: ReactNode;
    destructive: boolean;
    title: ReactNode;
  };
  resolve: (value: boolean) => void;
}

interface ConfirmState {
  active: ConfirmRequest | null;
  queue: Array<ConfirmRequest>;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

const defaultOptions = {
  cancelText: "Cancel",
  confirmText: "Confirm",
  destructive: false,
  title: "Are you sure?",
} as const;

const normalizeOptions = (options: ConfirmOptions): ConfirmRequest["options"] => {
  return {
    cancelText: options.cancelText ?? defaultOptions.cancelText,
    confirmText: options.confirmText ?? defaultOptions.confirmText,
    description: options.description,
    destructive: options.destructive ?? defaultOptions.destructive,
    title: options.title ?? defaultOptions.title,
  };
};

export const useConfirm = (): ConfirmFn => {
  const confirm = use(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used within a ConfirmProvider");
  return confirm;
};

const confirmReducer = (state: ConfirmState, action: ConfirmAction): ConfirmState => {
  switch (action.type) {
    case "dequeue": {
      const next = state.queue.at(0);
      if (!next) {
        return { active: null, queue: [] };
      }
      return { active: next, queue: state.queue.slice(1) };
    }
    case "enqueue": {
      if (state.active) {
        return { ...state, queue: [...state.queue, action.request] };
      }
      return { ...state, active: action.request };
    }
  }
};

export const ConfirmProvider = ({ children }: PropsWithChildren) => {
  const nextIdRef = useRef(1);
  const renderedRequestRef = useRef<ConfirmRequest | null>(null);
  const resolvingRef = useRef(false);

  const [state, dispatch] = useReducer(confirmReducer, { active: null, queue: [] });

  useEffect(() => {
    if (state.active) {
      renderedRequestRef.current = state.active;
    }
    resolvingRef.current = false;
  }, [state.active]);

  const resolveActive = useCallback(
    (value: boolean) => {
      const activeRequest = state.active;
      if (!activeRequest) return;
      if (resolvingRef.current) return;

      resolvingRef.current = true;
      activeRequest.resolve(value);
      dispatch({ type: "dequeue" });
    },
    [state.active],
  );

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      dispatch({
        request: {
          id: nextIdRef.current++,
          options: normalizeOptions(options),
          resolve,
        },
        type: "enqueue",
      });
    });
  }, []);

  const activeRequest = state.active;
  const renderedRequest = activeRequest ?? renderedRequestRef.current;
  const open = !!activeRequest;

  const cancelText = renderedRequest ? renderedRequest.options.cancelText : defaultOptions.cancelText;
  const confirmText = renderedRequest ? renderedRequest.options.confirmText : defaultOptions.confirmText;
  const description = renderedRequest ? renderedRequest.options.description : null;
  const isDestructive = renderedRequest ? renderedRequest.options.destructive : defaultOptions.destructive;
  const title = renderedRequest ? renderedRequest.options.title : defaultOptions.title;

  return (
    <ConfirmContext value={confirm}>
      <AlertDialog
        onOpenChange={(nextOpen) => {
          if (nextOpen) return;
          resolveActive(false);
        }}
        open={open}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                resolveActive(false);
              }}
            >
              {cancelText}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                resolveActive(true);
              }}
              variant={isDestructive ? "destructive" : "default"}
            >
              {confirmText}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {children}
    </ConfirmContext>
  );
};
