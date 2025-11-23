import { Check, FileText, Upload, X } from "lucide-react";
import { m } from "motion/react";
import * as React from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

interface FileUploadProps {
  accept?: string;
  className?: string;
  disabled?: boolean;
  maxSize?: number; // in MB
  multiple?: boolean;
  onFileSelect: (files: Array<File>) => void;
  placeholder?: string;
}

function FileUpload({
  accept = ".json,.yaml,.yml",
  className,
  disabled,
  maxSize = 10,
  multiple = false,
  onFileSelect,
  placeholder = "Upload OpenAPI specification files",
  ref,
}: { ref?: React.Ref<HTMLInputElement> } & FileUploadProps) {
  const [dragActive, setDragActive] = React.useState(false);
  const [files, setFiles] = React.useState<Array<File>>([]);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleDrag = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const validateFile = React.useCallback(
    (file: File): boolean => {
      if (maxSize && file.size > maxSize * 1024 * 1024) {
        console.error(`File ${file.name} is too large. Maximum size is ${maxSize}MB.`);
        return false;
      }
      return true;
    },
    [maxSize],
  );

  const handleDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      if (disabled) return;

      const droppedFiles = Array.from(e.dataTransfer.files).filter(validateFile);

      if (droppedFiles.length > 0) {
        const newFiles = multiple ? [...files, ...droppedFiles] : droppedFiles.slice(0, 1);
        setFiles(newFiles);
        onFileSelect(newFiles);
      }
    },
    [disabled, files, multiple, onFileSelect, validateFile],
  );

  const handleFileSelect = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled) return;

      const selectedFiles = Array.from(e.target.files ?? []).filter(validateFile);

      if (selectedFiles.length > 0) {
        const newFiles = multiple ? [...files, ...selectedFiles] : selectedFiles.slice(0, 1);
        setFiles(newFiles);
        onFileSelect(newFiles);
      }
    },
    [disabled, files, multiple, onFileSelect, validateFile],
  );

  const removeFile = React.useCallback(
    (index: number) => {
      const newFiles = files.filter((_, i) => i !== index);
      setFiles(newFiles);
      onFileSelect(newFiles);
    },
    [files, onFileSelect],
  );

  const openFileDialog = () => {
    inputRef.current?.click();
  };

  return (
    <div className={cn("w-full", className)}>
      <m.div
        animate={{
          backgroundColor: dragActive ? "rgb(239 246 255)" : "transparent",
          borderColor: dragActive ? "rgb(59 130 246)" : "rgb(209 213 219)",
        }}
        className={cn(
          "relative rounded-lg border-2 border-dashed p-6 transition-colors",
          disabled && "cursor-not-allowed opacity-50",
          !disabled &&
            `
            cursor-pointer
            hover:border-blue-400 hover:bg-blue-50/50
            dark:hover:bg-blue-950/50
          `,
        )}
        onClick={!disabled ? openFileDialog : undefined}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        transition={{ duration: 0.2 }}
        whileHover={!disabled ? { scale: 1.01 } : undefined}
      >
        <input
          accept={accept}
          className="hidden"
          disabled={disabled}
          multiple={multiple}
          onChange={handleFileSelect}
          ref={ref ?? inputRef}
          type="file"
        />

        <div className="flex flex-col items-center justify-center space-y-3">
          <m.div animate={{ rotate: dragActive ? 360 : 0 }} transition={{ duration: 0.6 }}>
            <Upload
              className={cn(
                "h-8 w-8",
                dragActive
                  ? "text-blue-500"
                  : `
              text-gray-400
            `,
              )}
            />
          </m.div>

          <div className="text-center">
            <p
              className={`
              text-sm font-medium text-gray-900
              dark:text-gray-100
            `}
            >
              {placeholder}
            </p>
            <p
              className={`
              text-xs text-gray-500
              dark:text-gray-400
            `}
            >
              Drag and drop files here, or click to browse
            </p>
            <p
              className={`
              mt-1 text-xs text-gray-400
              dark:text-gray-500
            `}
            >
              Supports JSON, YAML files up to {maxSize}MB
            </p>
          </div>
        </div>
      </m.div>

      {files.length > 0 && (
        <m.div animate={{ opacity: 1, y: 0 }} className="mt-4 space-y-2" initial={{ opacity: 0, y: 10 }}>
          {files.map((file, index) => (
            <m.div
              animate={{ opacity: 1, x: 0 }}
              className={`
                flex items-center justify-between rounded-md border bg-gray-50
                p-3
                dark:bg-gray-900
              `}
              initial={{ opacity: 0, x: -10 }}
              key={`${file.name}-${String(file.size)}-${String(file.lastModified)}`}
              transition={{ delay: index * 0.1 }}
            >
              <div className="flex items-center space-x-3">
                <FileText className="h-4 w-4 text-blue-500" />
                <div>
                  <p
                    className={`
                    text-sm font-medium text-gray-900
                    dark:text-gray-100
                  `}
                  >
                    {file.name}
                  </p>
                  <p
                    className={`
                    text-xs text-gray-500
                    dark:text-gray-400
                  `}
                  >
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <div className="flex items-center space-x-1 text-green-600">
                  <Check className="h-3 w-3" />
                  <span className="text-xs">Ready</span>
                </div>
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(index);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </m.div>
          ))}
        </m.div>
      )}
    </div>
  );
}

FileUpload.displayName = "FileUpload";

export { FileUpload };
