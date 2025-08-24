"use client";

import { Slot } from "@radix-ui/react-slot";
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileCogIcon,
  FileIcon,
  FileTextIcon,
  FileVideoIcon,
} from "lucide-react";
import * as React from "react";

import { cn } from "~/lib/utils/index";

const ROOT_NAME = "FileUpload";
const DROPZONE_NAME = "FileUploadDropzone";
const TRIGGER_NAME = "FileUploadTrigger";
const LIST_NAME = "FileUploadList";
const ITEM_NAME = "FileUploadItem";
const ITEM_PREVIEW_NAME = "FileUploadItemPreview";
const ITEM_METADATA_NAME = "FileUploadItemMetadata";
const ITEM_PROGRESS_NAME = "FileUploadItemProgress";
const ITEM_DELETE_NAME = "FileUploadItemDelete";
const CLEAR_NAME = "FileUploadClear";

type Direction = "ltr" | "rtl";

function useLazyRef<T>(fn: () => T) {
  const ref = React.useRef<null | T>(null);

  ref.current ??= fn();

  return ref as React.RefObject<T>;
}

const DirectionContext = React.createContext<Direction | undefined>(undefined);

interface FileState {
  error?: string;
  file: File;
  progress: number;
  status: "error" | "idle" | "success" | "uploading";
}

type StoreAction =
  | { dragOver: boolean; type: "SET_DRAG_OVER" }
  | { error: string; file: File; type: "SET_ERROR" }
  | { file: File; progress: number; type: "SET_PROGRESS" }
  | { file: File; type: "REMOVE_FILE" }
  | { file: File; type: "SET_SUCCESS" }
  | { files: Array<File>; type: "ADD_FILES" }
  | { files: Array<File>; type: "SET_FILES" }
  | { invalid: boolean; type: "SET_INVALID" }
  | { type: "CLEAR" };

interface StoreState {
  dragOver: boolean;
  files: Map<File, FileState>;
  invalid: boolean;
}

function createStore(
  listeners: Set<() => void>,
  files: Map<File, FileState>,
  urlCache: WeakMap<File, string>,
  invalid: boolean,
  onValueChange?: (files: Array<File>) => void,
) {
  let state: StoreState = {
    dragOver: false,
    files,
    invalid: invalid,
  };

  function reducer(state: StoreState, action: StoreAction): StoreState {
    switch (action.type) {
      case "ADD_FILES": {
        for (const file of action.files) {
          files.set(file, {
            file,
            progress: 0,
            status: "idle",
          });
        }

        if (onValueChange) {
          const fileList = Array.from(files.values()).map((fileState) => fileState.file);
          onValueChange(fileList);
        }
        return { ...state, files };
      }

      case "CLEAR": {
        for (const file of files.keys()) {
          const cachedUrl = urlCache.get(file);
          if (cachedUrl) {
            URL.revokeObjectURL(cachedUrl);
            urlCache.delete(file);
          }
        }

        files.clear();
        if (onValueChange) {
          onValueChange([]);
        }
        return { ...state, files, invalid: false };
      }

      case "REMOVE_FILE": {
        const cachedUrl = urlCache.get(action.file);
        if (cachedUrl) {
          URL.revokeObjectURL(cachedUrl);
          urlCache.delete(action.file);
        }

        files.delete(action.file);

        if (onValueChange) {
          const fileList = Array.from(files.values()).map((fileState) => fileState.file);
          onValueChange(fileList);
        }
        return { ...state, files };
      }

      case "SET_DRAG_OVER": {
        return { ...state, dragOver: action.dragOver };
      }

      case "SET_ERROR": {
        const fileState = files.get(action.file);
        if (fileState) {
          files.set(action.file, {
            ...fileState,
            error: action.error,
            status: "error",
          });
        }
        return { ...state, files };
      }

      case "SET_FILES": {
        const newFileSet = new Set(action.files);
        for (const existingFile of files.keys()) {
          if (!newFileSet.has(existingFile)) {
            files.delete(existingFile);
          }
        }

        for (const file of action.files) {
          const existingState = files.get(file);
          if (!existingState) {
            files.set(file, {
              file,
              progress: 0,
              status: "idle",
            });
          }
        }
        return { ...state, files };
      }

      case "SET_INVALID": {
        return { ...state, invalid: action.invalid };
      }

      case "SET_PROGRESS": {
        const fileState = files.get(action.file);
        if (fileState) {
          files.set(action.file, {
            ...fileState,
            progress: action.progress,
            status: "uploading",
          });
        }
        return { ...state, files };
      }

      case "SET_SUCCESS": {
        const fileState = files.get(action.file);
        if (fileState) {
          files.set(action.file, {
            ...fileState,
            progress: 100,
            status: "success",
          });
        }
        return { ...state, files };
      }

      default:
        return state;
    }
  }

  function getState() {
    return state;
  }

  function dispatch(action: StoreAction) {
    state = reducer(state, action);
    for (const listener of listeners) {
      listener();
    }
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { dispatch, getState, subscribe };
}

function useDirection(dirProp?: Direction): Direction {
  const contextDir = React.use(DirectionContext);
  return dirProp ?? contextDir ?? "ltr";
}

const StoreContext = React.createContext<null | ReturnType<typeof createStore>>(null);

interface FileUploadContextValue {
  dir: Direction;
  disabled: boolean;
  dropzoneId: string;
  inputId: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  labelId: string;
  listId: string;
  urlCache: WeakMap<File, string>;
}

function useStore<T>(selector: (state: StoreState) => T): T {
  const store = useStoreContext(ROOT_NAME);

  const lastValueRef = useLazyRef<{ state: StoreState; value: T } | null>(() => null);

  const getSnapshot = React.useCallback(() => {
    const state = store.getState();
    const prevValue = lastValueRef.current;

    if (prevValue && prevValue.state === state) {
      return prevValue.value;
    }

    const nextValue = selector(state);
    // eslint-disable-next-line react-compiler/react-compiler
    lastValueRef.current = { state, value: nextValue };
    return nextValue;
  }, [store, selector, lastValueRef]);

  return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

function useStoreContext(consumerName: string) {
  const context = React.use(StoreContext);
  if (!context) {
    throw new Error(`\`${consumerName}\` must be used within \`${ROOT_NAME}\``);
  }
  return context;
}

const FileUploadContext = React.createContext<FileUploadContextValue | null>(null);

interface FileUploadDropzoneProps extends React.ComponentPropsWithoutRef<"div"> {
  asChild?: boolean;
}

interface FileUploadItemContextValue {
  fileState: FileState | undefined;
  id: string;
  messageId: string;
  nameId: string;
  sizeId: string;
  statusId: string;
}

interface FileUploadListProps extends React.ComponentPropsWithoutRef<"div"> {
  asChild?: boolean;
  forceMount?: boolean;
  orientation?: "horizontal" | "vertical";
}

interface FileUploadRootProps extends Omit<React.ComponentPropsWithoutRef<"div">, "defaultValue" | "onChange"> {
  accept?: string;
  asChild?: boolean;
  defaultValue?: Array<File>;
  dir?: Direction;
  disabled?: boolean;
  invalid?: boolean;
  label?: string;
  maxFiles?: number;
  maxSize?: number;
  multiple?: boolean;
  name?: string;
  onAccept?: (files: Array<File>) => void;
  onFileAccept?: (file: File) => void;
  onFileReject?: (file: File, message: string) => void;
  onFileValidate?: (file: File) => null | string | undefined;
  onUpload?: (
    files: Array<File>,
    options: {
      onError: (file: File, error: Error) => void;
      onProgress: (file: File, progress: number) => void;
      onSuccess: (file: File) => void;
    },
  ) => Promise<void> | void;
  onValueChange?: (files: Array<File>) => void;
  required?: boolean;
  value?: Array<File>;
}

interface FileUploadTriggerProps extends React.ComponentPropsWithoutRef<"button"> {
  asChild?: boolean;
}

function FileUploadDropzone(props: FileUploadDropzoneProps) {
  const {
    asChild,
    className,
    onClick: onClickProp,
    onDragEnter: onDragEnterProp,
    onDragLeave: onDragLeaveProp,
    onDragOver: onDragOverProp,
    onDrop: onDropProp,
    onKeyDown: onKeyDownProp,
    onPaste: onPasteProp,
    ...dropzoneProps
  } = props;

  const context = useFileUploadContext(DROPZONE_NAME);
  const store = useStoreContext(DROPZONE_NAME);
  const dragOver = useStore((state) => state.dragOver);
  const invalid = useStore((state) => state.invalid);

  const onClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      onClickProp?.(event);

      if (event.defaultPrevented) return;

      const target = event.target;

      const isFromTrigger = target instanceof HTMLElement && target.closest('[data-slot="file-upload-trigger"]');

      if (!isFromTrigger) {
        context.inputRef.current?.click();
      }
    },
    [context.inputRef, onClickProp],
  );

  const onDragOver = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      onDragOverProp?.(event);

      if (event.defaultPrevented) return;

      event.preventDefault();
      store.dispatch({ dragOver: true, type: "SET_DRAG_OVER" });
    },
    [store, onDragOverProp],
  );

  const onDragEnter = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      onDragEnterProp?.(event);

      if (event.defaultPrevented) return;

      event.preventDefault();
      store.dispatch({ dragOver: true, type: "SET_DRAG_OVER" });
    },
    [store, onDragEnterProp],
  );

  const onDragLeave = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      onDragLeaveProp?.(event);

      if (event.defaultPrevented) return;

      const relatedTarget = event.relatedTarget;
      if (relatedTarget && relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
        return;
      }

      event.preventDefault();
      store.dispatch({ dragOver: false, type: "SET_DRAG_OVER" });
    },
    [store, onDragLeaveProp],
  );

  const onDrop = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      onDropProp?.(event);

      if (event.defaultPrevented) return;

      event.preventDefault();
      store.dispatch({ dragOver: false, type: "SET_DRAG_OVER" });

      const files = Array.from(event.dataTransfer.files);
      const inputElement = context.inputRef.current;
      if (!inputElement) return;

      const dataTransfer = new DataTransfer();
      for (const file of files) {
        dataTransfer.items.add(file);
      }

      // eslint-disable-next-line react-compiler/react-compiler
      inputElement.files = dataTransfer.files;
      inputElement.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [store, context.inputRef, onDropProp],
  );

  const onPaste = React.useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      onPasteProp?.(event);

      if (event.defaultPrevented) return;

      event.preventDefault();
      store.dispatch({ dragOver: false, type: "SET_DRAG_OVER" });

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const items = event.clipboardData?.items;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!items) return;

      const files: Array<File> = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length === 0) return;

      const inputElement = context.inputRef.current;
      if (!inputElement) return;

      const dataTransfer = new DataTransfer();
      for (const file of files) {
        dataTransfer.items.add(file);
      }

      inputElement.files = dataTransfer.files;
      inputElement.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [store, context.inputRef, onPasteProp],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDownProp?.(event);

      if (!event.defaultPrevented && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        context.inputRef.current?.click();
      }
    },
    [context.inputRef, onKeyDownProp],
  );

  const DropzonePrimitive = asChild ? Slot : "div";

  return (
    <DropzonePrimitive
      aria-controls={`${context.inputId} ${context.listId}`}
      aria-disabled={context.disabled}
      aria-invalid={invalid}
      data-disabled={context.disabled ? "" : undefined}
      data-dragging={dragOver ? "" : undefined}
      data-invalid={invalid ? "" : undefined}
      data-slot="file-upload-dropzone"
      dir={context.dir}
      id={context.dropzoneId}
      role="region"
      tabIndex={context.disabled ? undefined : 0}
      {...dropzoneProps}
      className={cn(
        // Neobrutalistic dropzone: bold border, offset shadow, animated hover translate removing shadow
        "rounded-base border-border bg-background relative flex flex-col items-center justify-center gap-3 border-2 p-6 outline-hidden transition-all select-none data-[disabled]:pointer-events-none",
        "shadow-shadow",
        // Drag/invalid feedback
        "data-[dragging]:bg-secondary-background data-[dragging]:border-primary/40",
        "data-[invalid]:border-destructive data-[invalid]:bg-destructive/5",
        // Focus ring to match neobrutal inputs/buttons
        "ring-offset-white focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2",
        className,
      )}
      onClick={onClick}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  );
}

function FileUploadList(props: FileUploadListProps) {
  const { asChild, className, forceMount = false, orientation = "vertical", ...listProps } = props;

  const context = useFileUploadContext(LIST_NAME);
  const fileCount = useStore((state) => state.files.size);
  const shouldRender = forceMount || fileCount > 0;

  if (!shouldRender) return null;

  const ListPrimitive = asChild ? Slot : "div";

  return (
    <ListPrimitive
      aria-orientation={orientation}
      data-orientation={orientation}
      data-slot="file-upload-list"
      data-state="active"
      dir={context.dir}
      id={context.listId}
      role="list"
      {...listProps}
      className={cn(
        // Keep subtle motion but align spacing with neobrutal UI
        "data-[state=inactive]:fade-out-0 data-[state=active]:fade-in-0 data-[state=inactive]:slide-out-to-top-2 data-[state=active]:slide-in-from-top-2 data-[state=active]:animate-in data-[state=inactive]:animate-out",
        "flex flex-col gap-3",
        orientation === "horizontal" && "flex-row overflow-x-auto p-2",
        className,
      )}
    />
  );
}

function FileUploadRoot(props: FileUploadRootProps) {
  const {
    accept,
    asChild,
    children,
    className,
    defaultValue,
    dir: dirProp,
    disabled = false,
    invalid = false,
    label,
    maxFiles,
    maxSize,
    multiple = false,
    name,
    onAccept,
    onFileAccept,
    onFileReject,
    onFileValidate,
    onUpload,
    onValueChange,
    required = false,
    value,
    ...rootProps
  } = props;

  const inputId = React.useId();
  const dropzoneId = React.useId();
  const listId = React.useId();
  const labelId = React.useId();

  const dir = useDirection(dirProp);
  const listeners = useLazyRef(() => new Set<() => void>()).current;
  const files = useLazyRef<Map<File, FileState>>(() => new Map()).current;
  const urlCache = useLazyRef(() => new WeakMap<File, string>()).current;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const isControlled = value !== undefined;

  const store = React.useMemo(
    () => createStore(listeners, files, urlCache, invalid, onValueChange),
    [listeners, files, invalid, onValueChange, urlCache],
  );

  const acceptTypes = React.useMemo(() => accept?.split(",").map((t) => t.trim()) ?? null, [accept]);

  const onProgress = useLazyRef(() => {
    let frame = 0;
    return (file: File, progress: number) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        store.dispatch({
          file,
          progress: Math.min(Math.max(0, progress), 100),
          type: "SET_PROGRESS",
        });
      });
    };
  }).current;

  React.useEffect(() => {
    if (isControlled) {
      store.dispatch({ files: value, type: "SET_FILES" });
    } else if (defaultValue && defaultValue.length > 0 && !store.getState().files.size) {
      store.dispatch({ files: defaultValue, type: "SET_FILES" });
    }
  }, [value, defaultValue, isControlled, store]);

  React.useEffect(() => {
    return () => {
      for (const file of files.keys()) {
        const cachedUrl = urlCache.get(file);
        if (cachedUrl) {
          URL.revokeObjectURL(cachedUrl);
        }
      }
    };
  }, [files, urlCache]);

  const onFilesUpload = React.useCallback(
    async (files: Array<File>) => {
      try {
        for (const file of files) {
          store.dispatch({ file, progress: 0, type: "SET_PROGRESS" });
        }

        if (onUpload) {
          await onUpload(files, {
            onError: (file, error) => {
              store.dispatch({
                error: error.message || "Upload failed",
                file,
                type: "SET_ERROR",
              });
            },
            onProgress,
            onSuccess: (file) => {
              store.dispatch({ file, type: "SET_SUCCESS" });
            },
          });
        } else {
          for (const file of files) {
            store.dispatch({ file, type: "SET_SUCCESS" });
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Upload failed";
        for (const file of files) {
          store.dispatch({
            error: errorMessage,
            file,
            type: "SET_ERROR",
          });
        }
      }
    },
    [store, onUpload, onProgress],
  );

  const onFilesChange = React.useCallback(
    (originalFiles: Array<File>) => {
      if (disabled) return;

      let filesToProcess = [...originalFiles];
      let invalid = false;

      if (maxFiles) {
        const currentCount = store.getState().files.size;
        const remainingSlotCount = Math.max(0, maxFiles - currentCount);

        if (remainingSlotCount < filesToProcess.length) {
          const rejectedFiles = filesToProcess.slice(remainingSlotCount);
          invalid = true;

          filesToProcess = filesToProcess.slice(0, remainingSlotCount);

          for (const file of rejectedFiles) {
            let rejectionMessage = `Maximum ${maxFiles} files allowed`;

            if (onFileValidate) {
              const validationMessage = onFileValidate(file);
              if (validationMessage) {
                rejectionMessage = validationMessage;
              }
            }

            onFileReject?.(file, rejectionMessage);
          }
        }
      }

      const acceptedFiles: Array<File> = [];
      const rejectedFiles: Array<{ file: File; message: string }> = [];

      for (const file of filesToProcess) {
        let rejected = false;
        let rejectionMessage = "";

        if (onFileValidate) {
          const validationMessage = onFileValidate(file);
          if (validationMessage) {
            rejectionMessage = validationMessage;
            onFileReject?.(file, rejectionMessage);
            rejected = true;
            invalid = true;
            continue;
          }
        }

        if (acceptTypes) {
          const fileType = file.type;
          const fileExtension = `.${file.name.split(".").pop()}`;

          if (
            !acceptTypes.some(
              (type) =>
                type === fileType ||
                type === fileExtension ||
                (type.includes("/*") && fileType.startsWith(type.replace("/*", "/"))),
            )
          ) {
            rejectionMessage = "File type not accepted";
            onFileReject?.(file, rejectionMessage);
            rejected = true;
            invalid = true;
          }
        }

        if (maxSize && file.size > maxSize) {
          rejectionMessage = "File too large";
          onFileReject?.(file, rejectionMessage);
          rejected = true;
          invalid = true;
        }

        if (!rejected) {
          acceptedFiles.push(file);
        } else {
          rejectedFiles.push({ file, message: rejectionMessage });
        }
      }

      if (invalid) {
        store.dispatch({ invalid, type: "SET_INVALID" });
        setTimeout(() => {
          store.dispatch({ invalid: false, type: "SET_INVALID" });
        }, 2000);
      }

      if (acceptedFiles.length > 0) {
        store.dispatch({ files: acceptedFiles, type: "ADD_FILES" });

        if (isControlled && onValueChange) {
          const currentFiles = Array.from(store.getState().files.values()).map((f) => f.file);
          onValueChange([...currentFiles]);
        }

        if (onAccept) {
          onAccept(acceptedFiles);
        }

        for (const file of acceptedFiles) {
          onFileAccept?.(file);
        }

        if (onUpload) {
          requestAnimationFrame(() => {
            void onFilesUpload(acceptedFiles);
          });
        }
      }
    },
    [
      disabled,
      maxFiles,
      store,
      onFileValidate,
      onFileReject,
      acceptTypes,
      maxSize,
      isControlled,
      onValueChange,
      onAccept,
      onUpload,
      onFileAccept,
      onFilesUpload,
    ],
  );

  const onInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      onFilesChange(files);
      event.target.value = "";
    },
    [onFilesChange],
  );

  const contextValue = React.useMemo<FileUploadContextValue>(
    () => ({
      dir,
      disabled,
      dropzoneId,
      inputId,
      inputRef,
      labelId,
      listId,
      urlCache,
    }),
    [dropzoneId, inputId, listId, labelId, dir, disabled, urlCache],
  );

  const RootPrimitive = asChild ? Slot : "div";

  return (
    <StoreContext value={store}>
      <FileUploadContext value={contextValue}>
        <RootPrimitive
          data-disabled={disabled ? "" : undefined}
          data-slot="file-upload"
          dir={dir}
          {...rootProps}
          className={cn("relative flex flex-col gap-3", className)}
        >
          {children}
          <input
            accept={accept}
            aria-describedby={dropzoneId}
            aria-labelledby={labelId}
            className="sr-only"
            disabled={disabled}
            id={inputId}
            multiple={multiple}
            name={name}
            onChange={onInputChange}
            ref={inputRef}
            required={required}
            tabIndex={-1}
            type="file"
          />
          <span className="sr-only" id={labelId}>
            {label ?? "File upload"}
          </span>
        </RootPrimitive>
      </FileUploadContext>
    </StoreContext>
  );
}

function FileUploadTrigger(props: FileUploadTriggerProps) {
  const { asChild, onClick: onClickProp, ...triggerProps } = props;
  const context = useFileUploadContext(TRIGGER_NAME);

  const onClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClickProp?.(event);

      if (event.defaultPrevented) return;

      context.inputRef.current?.click();
    },
    [context.inputRef, onClickProp],
  );

  const TriggerPrimitive = asChild ? Slot : "button";

  return (
    <TriggerPrimitive
      aria-controls={context.inputId}
      data-disabled={context.disabled ? "" : undefined}
      data-slot="file-upload-trigger"
      type="button"
      {...triggerProps}
      disabled={context.disabled}
      onClick={onClick}
    />
  );
}

function useFileUploadContext(consumerName: string) {
  const context = React.use(FileUploadContext);
  if (!context) {
    throw new Error(`\`${consumerName}\` must be used within \`${ROOT_NAME}\``);
  }
  return context;
}

const FileUploadItemContext = React.createContext<FileUploadItemContextValue | null>(null);

interface FileUploadClearProps extends React.ComponentPropsWithoutRef<"button"> {
  asChild?: boolean;
  forceMount?: boolean;
}

interface FileUploadItemDeleteProps extends React.ComponentPropsWithoutRef<"button"> {
  asChild?: boolean;
}

interface FileUploadItemMetadataProps extends React.ComponentPropsWithoutRef<"div"> {
  asChild?: boolean;
  size?: "default" | "sm";
}

interface FileUploadItemPreviewProps extends React.ComponentPropsWithoutRef<"div"> {
  asChild?: boolean;
  render?: (file: File) => React.ReactNode;
}

interface FileUploadItemProgressProps extends React.ComponentPropsWithoutRef<"div"> {
  asChild?: boolean;
  forceMount?: boolean;
  size?: number;
  variant?: "circular" | "fill" | "linear";
}

interface FileUploadItemProps extends React.ComponentPropsWithoutRef<"div"> {
  asChild?: boolean;
  value: File;
}

function FileUploadClear(props: FileUploadClearProps) {
  const { asChild, disabled = false, forceMount = false, onClick: onClickProp, ...clearProps } = props;

  const context = useFileUploadContext(CLEAR_NAME);
  const store = useStoreContext(CLEAR_NAME);
  const fileCount = useStore((state) => state.files.size);

  const isDisabled = disabled || context.disabled;

  const onClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClickProp?.(event);

      if (event.defaultPrevented) return;

      store.dispatch({ type: "CLEAR" });
    },
    [store, onClickProp],
  );

  const shouldRender = forceMount || fileCount > 0;

  if (!shouldRender) return null;

  const ClearPrimitive = asChild ? Slot : "button";

  return (
    <ClearPrimitive
      aria-controls={context.listId}
      data-disabled={isDisabled ? "" : undefined}
      data-slot="file-upload-clear"
      type="button"
      {...clearProps}
      disabled={isDisabled}
      onClick={onClick}
    />
  );
}

function FileUploadItem(props: FileUploadItemProps) {
  const { asChild, className, value, ...itemProps } = props;

  const id = React.useId();
  const statusId = `${id}-status`;
  const nameId = `${id}-name`;
  const sizeId = `${id}-size`;
  const messageId = `${id}-message`;

  const context = useFileUploadContext(ITEM_NAME);
  const fileState = useStore((state) => state.files.get(value));
  const fileCount = useStore((state) => state.files.size);
  const fileIndex = useStore((state) => {
    const files = Array.from(state.files.keys());
    return files.indexOf(value) + 1;
  });

  const itemContext = React.useMemo(
    () => ({
      fileState,
      id,
      messageId,
      nameId,
      sizeId,
      statusId,
    }),
    [id, fileState, statusId, nameId, sizeId, messageId],
  );

  if (!fileState) return null;

  const statusText = fileState.error
    ? `Error: ${fileState.error}`
    : fileState.status === "uploading"
      ? `Uploading: ${fileState.progress}% complete`
      : fileState.status === "success"
        ? "Upload complete"
        : "Ready to upload";

  const ItemPrimitive = asChild ? Slot : "div";

  return (
    <FileUploadItemContext value={itemContext}>
      <ItemPrimitive
        aria-describedby={`${nameId} ${sizeId} ${statusId} ${fileState.error ? messageId : ""}`}
        aria-labelledby={nameId}
        aria-posinset={fileIndex}
        aria-setsize={fileCount}
        data-slot="file-upload-item"
        dir={context.dir}
        id={id}
        role="listitem"
        {...itemProps}
        className={cn(
          // Neobrutal list item: strong border, shadow, spacing
          "rounded-base border-border bg-background shadow-shadow relative flex items-center gap-3 border-2 p-3",
          className,
        )}
      >
        {props.children}
        <span className="sr-only" id={statusId}>
          {statusText}
        </span>
      </ItemPrimitive>
    </FileUploadItemContext>
  );
}

function FileUploadItemDelete(props: FileUploadItemDeleteProps) {
  const { asChild, onClick: onClickProp, ...deleteProps } = props;

  const store = useStoreContext(ITEM_DELETE_NAME);
  const itemContext = useFileUploadItemContext(ITEM_DELETE_NAME);

  const onClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClickProp?.(event);

      if (!itemContext.fileState || event.defaultPrevented) return;

      store.dispatch({
        file: itemContext.fileState.file,
        type: "REMOVE_FILE",
      });
    },
    [store, itemContext.fileState, onClickProp],
  );

  if (!itemContext.fileState) return null;

  const ItemDeletePrimitive = asChild ? Slot : "button";

  return (
    <ItemDeletePrimitive
      aria-controls={itemContext.id}
      aria-describedby={itemContext.nameId}
      data-slot="file-upload-item-delete"
      type="button"
      {...deleteProps}
      onClick={onClick}
    />
  );
}
function FileUploadItemMetadata(props: FileUploadItemMetadataProps) {
  const { asChild, children, className, size = "default", ...metadataProps } = props;

  const context = useFileUploadContext(ITEM_METADATA_NAME);
  const itemContext = useFileUploadItemContext(ITEM_METADATA_NAME);

  if (!itemContext.fileState) return null;

  const ItemMetadataPrimitive = asChild ? Slot : "div";

  return (
    <ItemMetadataPrimitive
      data-slot="file-upload-metadata"
      dir={context.dir}
      {...metadataProps}
      className={cn("text-foreground flex min-w-0 flex-1 flex-col", className)}
    >
      {children ?? (
        <>
          <span
            className={cn("font-base truncate text-sm", size === "sm" && "text-[13px] leading-snug")}
            id={itemContext.nameId}
          >
            {itemContext.fileState.file.name}
          </span>
          <span
            className={cn(
              "text-muted-foreground font-base truncate text-xs",
              size === "sm" && "text-[11px] leading-snug",
            )}
            id={itemContext.sizeId}
          >
            {formatBytes(itemContext.fileState.file.size)}
          </span>
          {itemContext.fileState.error && (
            <span className="text-destructive font-base text-xs" id={itemContext.messageId}>
              {itemContext.fileState.error}
            </span>
          )}
        </>
      )}
    </ItemMetadataPrimitive>
  );
}

function FileUploadItemPreview(props: FileUploadItemPreviewProps) {
  const { asChild, children, className, render, ...previewProps } = props;

  const itemContext = useFileUploadItemContext(ITEM_PREVIEW_NAME);
  const context = useFileUploadContext(ITEM_PREVIEW_NAME);

  const onPreviewRender = React.useCallback(
    (file: File) => {
      if (render) return render(file);

      if (itemContext.fileState?.file.type.startsWith("image/")) {
        let url = context.urlCache.get(file);
        if (!url) {
          url = URL.createObjectURL(file);
          context.urlCache.set(file, url);
        }

        return <img alt={file.name} className="size-full object-cover" src={url} />;
      }

      return getFileIcon(file);
    },
    [render, itemContext.fileState?.file.type, context.urlCache],
  );

  if (!itemContext.fileState) return null;

  const ItemPreviewPrimitive = asChild ? Slot : "div";

  return (
    <ItemPreviewPrimitive
      aria-labelledby={itemContext.nameId}
      data-slot="file-upload-preview"
      {...previewProps}
      className={cn(
        // Neobrutal preview tile
        "rounded-base border-border bg-secondary-background relative flex size-12 shrink-0 items-center justify-center overflow-hidden border-2 [&>svg]:size-10",
        className,
      )}
    >
      {onPreviewRender(itemContext.fileState.file)}
      {children}
    </ItemPreviewPrimitive>
  );
}

function FileUploadItemProgress(props: FileUploadItemProgressProps) {
  const { asChild, className, forceMount = false, size = 40, variant = "linear", ...progressProps } = props;

  const itemContext = useFileUploadItemContext(ITEM_PROGRESS_NAME);

  if (!itemContext.fileState) return null;

  const shouldRender = forceMount || itemContext.fileState.progress !== 100;

  if (!shouldRender) return null;

  const ItemProgressPrimitive = asChild ? Slot : "div";

  switch (variant) {
    case "circular": {
      const circumference = 2 * Math.PI * ((size - 4) / 2);
      const strokeDashoffset = circumference - (itemContext.fileState.progress / 100) * circumference;

      return (
        <ItemProgressPrimitive
          aria-labelledby={itemContext.nameId}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={itemContext.fileState.progress}
          aria-valuetext={`${itemContext.fileState.progress}%`}
          data-slot="file-upload-progress"
          role="progressbar"
          {...progressProps}
          className={cn("text-foreground absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2", className)}
        >
          <svg
            className="rotate-[-90deg] transform"
            fill="none"
            height={size}
            stroke="currentColor"
            viewBox={`0 0 ${size} ${size}`}
            width={size}
          >
            <circle className="text-primary/20" cx={size / 2} cy={size / 2} r={(size - 4) / 2} strokeWidth="3" />
            <circle
              className="text-primary transition-[stroke-dashoffset] duration-300 ease-linear"
              cx={size / 2}
              cy={size / 2}
              r={(size - 4) / 2}
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              strokeWidth="3"
            />
          </svg>
        </ItemProgressPrimitive>
      );
    }

    case "fill": {
      const progressPercentage = itemContext.fileState.progress;
      const topInset = 100 - progressPercentage;

      return (
        <ItemProgressPrimitive
          aria-labelledby={itemContext.nameId}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progressPercentage}
          aria-valuetext={`${progressPercentage}%`}
          data-slot="file-upload-progress"
          role="progressbar"
          {...progressProps}
          className={cn("bg-primary/50 absolute inset-0 transition-[clip-path] duration-300 ease-linear", className)}
          style={{
            clipPath: `inset(${topInset}% 0% 0% 0%)`,
          }}
        />
      );
    }

    default:
      return (
        <ItemProgressPrimitive
          aria-labelledby={itemContext.nameId}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={itemContext.fileState.progress}
          aria-valuetext={`${itemContext.fileState.progress}%`}
          data-slot="file-upload-progress"
          role="progressbar"
          {...progressProps}
          className={cn(
            // Neobrutal linear progress: bold track and border
            "rounded-base border-border bg-secondary-background text-foreground relative h-2.5 w-full overflow-hidden border-2",
            className,
          )}
        >
          <div
            className="bg-primary h-full w-full flex-1 transition-transform duration-300 ease-linear"
            style={{
              transform: `translateX(-${100 - itemContext.fileState.progress}%)`,
            }}
          />
        </ItemProgressPrimitive>
      );
  }
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${sizes[i]}`;
}

function getFileIcon(file: File) {
  const type = file.type;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (type.startsWith("video/")) {
    return <FileVideoIcon />;
  }

  if (type.startsWith("audio/")) {
    return <FileAudioIcon />;
  }

  if (type.startsWith("text/") || ["md", "pdf", "rtf", "txt"].includes(extension)) {
    return <FileTextIcon />;
  }

  if (
    ["c", "cpp", "cs", "css", "html", "java", "js", "json", "jsx", "php", "py", "rb", "ts", "tsx", "xml"].includes(
      extension,
    )
  ) {
    return <FileCodeIcon />;
  }

  if (["7z", "bz2", "gz", "rar", "tar", "zip"].includes(extension)) {
    return <FileArchiveIcon />;
  }

  if (["apk", "app", "deb", "exe", "msi", "rpm"].includes(extension) || type.startsWith("application/")) {
    return <FileCogIcon />;
  }

  return <FileIcon />;
}

function useFileUploadItemContext(consumerName: string) {
  const context = React.use(FileUploadItemContext);
  if (!context) {
    throw new Error(`\`${consumerName}\` must be used within \`${ITEM_NAME}\``);
  }
  return context;
}

export {
  FileUploadClear as Clear,
  FileUploadDropzone as Dropzone,
  FileUploadRoot as FileUpload,
  FileUploadClear,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemMetadata,
  FileUploadItemPreview,
  FileUploadItemProgress,
  FileUploadList,
  //
  type FileUploadRootProps as FileUploadProps,
  FileUploadTrigger,
  FileUploadItem as Item,
  FileUploadItemDelete as ItemDelete,
  FileUploadItemMetadata as ItemMetadata,
  FileUploadItemPreview as ItemPreview,
  FileUploadItemProgress as ItemProgress,
  FileUploadList as List,
  //
  FileUploadRoot as Root,
  FileUploadTrigger as Trigger,
  //
  useStore as useFileUpload,
};
