import Editor from "@monaco-editor/react";
import Monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useTheme } from "~/components/theme-provider";

interface Diagnostic {
  column: number;
  line: number;
  message: string;
  path?: string;
}

interface OnEditorReadyPayload {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
}

interface OpenApiEditorProps {
  diagnostics?: Array<Diagnostic>;
  height?: number | string;
  language: "json" | "yaml";
  onChange: (value: string) => void;
  onEditorReady?: (payload: OnEditorReadyPayload) => void;
  readOnly?: boolean;
  value: string;
}

const DEFAULT_HEIGHT = "100%";

const EMPTY_DIAGNOSTICS: Array<Diagnostic> = [];

export function OpenApiEditor({
  diagnostics = EMPTY_DIAGNOSTICS,
  height = DEFAULT_HEIGHT,
  language,
  onChange,
  onEditorReady,
  readOnly = false,
  value,
}: OpenApiEditorProps) {
  const { theme } = useTheme();
  const monacoRef = useRef<null | typeof Monaco>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  const editorOptions = useMemo(
    () => ({
      automaticLayout: true,
      cursorSmoothCaretAnimation: "on" as const,
      fontFamily: 'SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
      fontSize: 13,
      glyphMargin: true,
      lineNumbers: "on" as const,
      minimap: { enabled: false },
      readOnly,
      renderValidationDecorations: "on" as const,
      scrollBeyondLastLine: false,
      "semanticHighlighting.enabled": true,
      smoothScrolling: true,
      wordWrap: "on" as const,
    }),
    [readOnly],
  );

  const syncMarkersWithDiagnostics = useCallback(() => {
    const monaco = monacoRef.current;
    if (!monaco || !editorRef.current) return;

    const model = editorRef.current.getModel();
    if (!model) return;

    const markers = diagnostics.map((diagnostic) => {
      const clampedLineNumber = Math.min(Math.max(diagnostic.line, 1), model.getLineCount());
      const maxColumn = model.getLineMaxColumn(clampedLineNumber);
      const startColumn = maxColumn > 1 ? Math.min(Math.max(diagnostic.column, 1), Math.max(maxColumn - 1, 1)) : 1;
      const endColumn = maxColumn > 1 ? Math.min(startColumn + 1, maxColumn) : startColumn;

      return {
        endColumn,
        endLineNumber: clampedLineNumber,
        message: diagnostic.path ? `${diagnostic.message}\n\nPath: ${diagnostic.path}` : diagnostic.message,
        severity: monaco.MarkerSeverity.Error,
        startColumn,
        startLineNumber: clampedLineNumber,
      };
    });

    monaco.editor.setModelMarkers(model, "openapi", markers);
  }, [diagnostics]);

  useEffect(() => {
    syncMarkersWithDiagnostics();
  }, [syncMarkersWithDiagnostics]);

  return (
    <Editor
      beforeMount={(monaco: typeof Monaco) => {
        monacoRef.current = monaco;

        // Configure JSON language with OpenAPI 3.1 schema for autocomplete
        if (language === "json") {
          monaco.json.jsonDefaults.setDiagnosticsOptions({
            allowComments: false,
            schemas: [
              {
                fileMatch: ["*"],
                schema: {
                  $schema: "http://json-schema.org/draft-07/schema#",
                  definitions: {
                    operation: {
                      properties: {
                        description: {
                          description: "A verbose explanation of the operation behavior",
                          type: "string",
                        },
                        operationId: {
                          description: "Unique string used to identify the operation",
                          type: "string",
                        },
                        parameters: {
                          items: { type: "object" },
                          type: "array",
                        },
                        requestBody: {
                          properties: {
                            content: { type: "object" },
                            required: { type: "boolean" },
                          },
                          type: "object",
                        },
                        responses: {
                          additionalProperties: {
                            properties: {
                              content: { type: "object" },
                              description: { type: "string" },
                            },
                            type: "object",
                          },
                          type: "object",
                        },
                        summary: {
                          description: "A short summary of what the operation does",
                          type: "string",
                        },
                        tags: {
                          items: { type: "string" },
                          type: "array",
                        },
                      },
                      type: "object",
                    },
                  },
                  properties: {
                    components: {
                      description: "Reusable components for the API",
                      properties: {
                        headers: {
                          additionalProperties: true,
                          type: "object",
                        },
                        parameters: {
                          additionalProperties: true,
                          type: "object",
                        },
                        requestBodies: {
                          additionalProperties: true,
                          type: "object",
                        },
                        responses: {
                          additionalProperties: true,
                          type: "object",
                        },
                        schemas: {
                          additionalProperties: true,
                          type: "object",
                        },
                        securitySchemes: {
                          additionalProperties: true,
                          type: "object",
                        },
                      },
                      type: "object",
                    },
                    info: {
                      properties: {
                        contact: {
                          properties: {
                            email: { format: "email", type: "string" },
                            name: { type: "string" },
                            url: { format: "uri", type: "string" },
                          },
                          type: "object",
                        },
                        description: {
                          description: "A description of the API",
                          type: "string",
                        },
                        license: {
                          properties: {
                            name: { type: "string" },
                            url: { format: "uri", type: "string" },
                          },
                          required: ["name"],
                          type: "object",
                        },
                        title: {
                          description: "The title of the API",
                          type: "string",
                        },
                        version: {
                          description: "The version of the OpenAPI document",
                          type: "string",
                        },
                      },
                      required: ["title", "version"],
                      type: "object",
                    },
                    openapi: {
                      description: "The OpenAPI Specification version",
                      pattern: "^3\\.[0-9]+\\.[0-9]+$",
                      type: "string",
                    },
                    paths: {
                      additionalProperties: {
                        properties: {
                          delete: { $ref: "#/definitions/operation" },
                          get: { $ref: "#/definitions/operation" },
                          head: { $ref: "#/definitions/operation" },
                          options: { $ref: "#/definitions/operation" },
                          patch: { $ref: "#/definitions/operation" },
                          post: { $ref: "#/definitions/operation" },
                          put: { $ref: "#/definitions/operation" },
                          trace: { $ref: "#/definitions/operation" },
                        },
                        type: "object",
                      },
                      description: "The available paths and operations for the API",
                      type: "object",
                    },
                    security: {
                      items: {
                        additionalProperties: {
                          items: { type: "string" },
                          type: "array",
                        },
                        type: "object",
                      },
                      type: "array",
                    },
                    servers: {
                      items: {
                        properties: {
                          description: {
                            description: "An optional string describing the host",
                            type: "string",
                          },
                          url: {
                            description: "A URL to the target host",
                            type: "string",
                          },
                        },
                        required: ["url"],
                        type: "object",
                      },
                      type: "array",
                    },
                    tags: {
                      items: {
                        properties: {
                          description: { type: "string" },
                          name: { type: "string" },
                        },
                        required: ["name"],
                        type: "object",
                      },
                      type: "array",
                    },
                  },
                  required: ["openapi", "info"],
                  type: "object",
                },
                uri: "http://openapi.local/schema.json",
              },
            ],
            schemaValidation: "ignore",
            validate: false,
          });
        }
      }}
      height={height}
      language={language}
      onChange={(nextValue) => onChange(nextValue ?? "")}
      onMount={(editor) => {
        editorRef.current = editor;
        syncMarkersWithDiagnostics();
        if (onEditorReady && monacoRef.current) {
          onEditorReady({ editor, monaco: monacoRef.current });
        }
      }}
      options={editorOptions}
      theme={theme === "dark" ? "vs-dark" : "light"}
      value={value}
    />
  );
}
