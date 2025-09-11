import { AlertCircle, CheckCircle, FileText, Upload, X } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useTRPCClient } from "~/lib/trpc";
import { cn } from "~/lib/utils";

interface OpenApiFileUploadProps {
  className?: string;
  disabled?: boolean;
  onFileRemove: () => void;
  onFileSelect: (file: File, validationResult: ValidationResult) => void;
  selectedFile?: File;
  validationResult?: ValidationResult;
}

interface ValidationError {
  code: string;
  message: string;
  path?: string;
}

interface ValidationResult {
  errors?: Array<ValidationError>;
  isValid: boolean;
  spec?: {
    endpointCount: number;
    format: "json" | "yaml";
    title: string;
    version: string;
  };
}

export function OpenApiFileUpload({
  className,
  disabled = false,
  onFileRemove,
  onFileSelect,
  selectedFile,
  validationResult,
}: OpenApiFileUploadProps) {
  const [dragActive, setDragActive] = React.useState(false);
  const [isValidating, setIsValidating] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const trpcClient = useTRPCClient();

  const validateFile = async (file: File) => {
    setIsValidating(true);

    try {
      const fileContent = await file.text();
      const result = await trpcClient.apiSpec.validate.mutate({
        fileContent,
        fileName: file.name,
      });

      onFileSelect(file, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Validation failed";
      onFileSelect(file, {
        errors: [
          {
            code: "VALIDATION_ERROR",
            message: errorMessage,
          },
        ],
        isValid: false,
      });
    } finally {
      setIsValidating(false);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (disabled) return;

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (isValidFileType(file)) {
        void validateFile(file);
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;

    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (isValidFileType(file)) {
        void validateFile(file);
      }
    }
  };

  const isValidFileType = (file: File) => {
    const validExtensions = [".json", ".yaml", ".yml"];
    const fileExtension = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    return validExtensions.includes(fileExtension);
  };

  const openFileDialog = () => {
    if (!disabled && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleRemoveFile = () => {
    onFileRemove();
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <div className={cn("space-y-3", className)}>
      {!selectedFile ? (
        <div
          className={cn(
            "relative cursor-pointer rounded-lg border-2 border-dashed p-6 transition-colors",
            "hover:bg-muted/50 focus:ring-ring focus:ring-2 focus:ring-offset-2 focus:outline-none",
            dragActive ? "border-primary bg-primary/10" : "border-muted-foreground/25",
            disabled && "cursor-not-allowed opacity-50",
          )}
          onClick={openFileDialog}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <input
            accept=".json,.yaml,.yml"
            className="hidden"
            disabled={disabled}
            onChange={handleFileChange}
            ref={fileInputRef}
            type="file"
          />

          <div className="text-center">
            <Upload className="text-muted-foreground mx-auto h-12 w-12" />
            <div className="mt-4">
              <p className="text-sm font-medium">Upload OpenAPI Specification</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Drag and drop your OpenAPI file here, or click to browse
              </p>
              <p className="text-muted-foreground mt-1 text-xs">Supports JSON (.json) and YAML (.yaml, .yml) formats</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {/* File Info */}
          <div className="bg-muted/50 flex items-center gap-3 rounded-lg p-3">
            <FileText className="h-8 w-8 text-blue-500" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{selectedFile.name}</p>
              <p className="text-muted-foreground text-xs">{(selectedFile.size / 1024).toFixed(1)} KB</p>
            </div>
            <Button className="h-8 w-8 p-0" disabled={disabled} onClick={handleRemoveFile} size="sm" variant="ghost">
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Validation Status */}
          {isValidating ? (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>Validating OpenAPI specification...</AlertDescription>
            </Alert>
          ) : validationResult ? (
            <div className="space-y-2">
              {validationResult.isValid ? (
                <Alert className="border-green-200 bg-green-50">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-800">
                    <div className="space-y-1">
                      <p className="font-medium">Valid OpenAPI specification!</p>
                      {validationResult.spec && (
                        <div className="text-sm">
                          <p>
                            <strong>Title:</strong> {validationResult.spec.title}
                          </p>
                          <p>
                            <strong>Version:</strong> {validationResult.spec.version}
                          </p>
                          <p>
                            <strong>Format:</strong> {validationResult.spec.format.toUpperCase()}
                          </p>
                          <p>
                            <strong>Endpoints:</strong> {validationResult.spec.endpointCount}
                          </p>
                        </div>
                      )}
                    </div>
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    <div className="space-y-1">
                      <p className="font-medium">OpenAPI validation failed:</p>
                      {validationResult.errors && validationResult.errors.length > 0 && (
                        <ul className="list-inside list-disc space-y-1 text-sm">
                          {validationResult.errors.map((error) => (
                            <li key={`${error.code}-${error.path ?? error.message}`}>
                              {error.path ? `${error.path}: ` : ""}
                              {error.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
