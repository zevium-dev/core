import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useTRPC } from "~/lib/trpc";

interface ScalarApiReferenceProps {
  _projectSlug: string;
  _specTitle?: string;
  specId: string;
  version: string;
}

interface ScalarConfig {
  authentication?: {
    securitySchemes?: {
      bearerAuth?: {
        token?: string;
      };
    };
  };
  configuration?: {
    customCss?: string;
    darkMode?: boolean;
    hideDownloadButton?: boolean;
    hideTestRequestButton?: boolean;
    isEditable?: boolean;
    layout?: string;
    showSidebar?: boolean;
    theme?: string;
    withDefaultFonts?: boolean;
  };
  spec?: {
    content?: unknown;
  };
}

export function ScalarApiReference({ _projectSlug, _specTitle, specId, version }: ScalarApiReferenceProps) {
  const trpc = useTRPC();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isScalarLoaded, setIsScalarLoaded] = React.useState(false);
  const scriptLoadedRef = React.useRef(false);

  // Fetch the API spec data
  const { data: specData, error, isPending } = useQuery(trpc.apiSpec.getById.queryOptions({ specId }));

  // Callback to mark Scalar as loaded
  const markScalarAsLoaded = React.useCallback(() => {
    scriptLoadedRef.current = true;
    setIsScalarLoaded(true);
  }, []);

  // Load Scalar script dynamically
  React.useEffect(() => {
    if (scriptLoadedRef.current) {
      return;
    }

    const loadScalar = () => {
      try {
        // Check if Scalar is already loaded
        if (typeof window.Scalar !== "undefined") {
          markScalarAsLoaded();
          return;
        }

        // Create script element for Scalar
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";
        script.async = true;

        script.onload = () => {
          markScalarAsLoaded();
        };

        script.onerror = () => {
          console.error("Failed to load Scalar API Reference");
        };

        document.head.appendChild(script);

        // Cleanup function
        return () => {
          if (script.parentNode) {
            script.parentNode.removeChild(script);
          }
        };
      } catch (error) {
        console.error("Error loading Scalar:", error);
      }
    };

    const cleanup = loadScalar();
    return cleanup;
  }, [markScalarAsLoaded]);

  // Initialize Scalar when both the script and data are loaded
  React.useEffect(() => {
    if (!isScalarLoaded || !specData?.spec || !containerRef.current) {
      return;
    }

    const container = containerRef.current;

    try {
      // Clear any existing content
      container.innerHTML = "";

      // Get the OpenAPI spec content
      const specContent = specData.spec.originalRaw ?? JSON.stringify(specData.spec.specJson, null, 2);

      if (!specContent) {
        container.innerHTML = '<p class="text-center py-8 text-gray-500">No API specification content available</p>';
        return;
      }

      // Parse the spec content to ensure it's valid JSON
      let parsedSpec: unknown;
      try {
        if (typeof specContent === "string") {
          // Try parsing as JSON first, fallback to YAML parsing if needed
          try {
            parsedSpec = JSON.parse(specContent);
          } catch {
            // If JSON parsing fails, treat as YAML or use the specJson
            parsedSpec = specData.spec.specJson;
          }
        } else {
          parsedSpec = specContent;
        }
      } catch (parseError) {
        console.error("Failed to parse spec content:", parseError);
        parsedSpec = specData.spec.specJson;
      }

      // Use requestAnimationFrame for smoother initialization
      requestAnimationFrame(() => {
        try {
          // Initialize Scalar
          const config: ScalarConfig = {
            authentication: {
              securitySchemes: {
                bearerAuth: {
                  token: "your-token-here", // This could be made configurable
                },
              },
            },
            configuration: {
              customCss: `
                .scalar-app {
                  border-radius: 8px;
                  scroll-behavior: smooth;
                  -webkit-overflow-scrolling: touch;
                }
                .scalar-card {
                  box-shadow: none;
                  border: 1px solid #e5e7eb;
                }
                /* Smooth scrolling improvements */
                * {
                  scroll-behavior: smooth;
                }

                /* Enhanced scrollbar styling */
                ::-webkit-scrollbar {
                  width: 8px;
                  height: 8px;
                }

                ::-webkit-scrollbar-track {
                  background: #f1f5f9;
                  border-radius: 4px;
                }

                ::-webkit-scrollbar-thumb {
                  background: #cbd5e1;
                  border-radius: 4px;
                  transition: background-color 0.2s ease;
                }

                ::-webkit-scrollbar-thumb:hover {
                  background: #94a3b8;
                }

                /* Optimize rendering performance */
                .scalar-app,
                .scalar-app * {
                  -webkit-transform: translateZ(0);
                  transform: translateZ(0);
                  backface-visibility: hidden;
                  perspective: 1000px;
                }

                /* Smooth transitions for interactive elements */
                .scalar-app button,
                .scalar-app a,
                .scalar-app [role="button"] {
                  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                }

                /* Prevent layout shifts */
                .scalar-app img {
                  max-width: 100%;
                  height: auto;
                }

                /* Enhanced focus states */
                .scalar-app *:focus {
                  outline: 2px solid #3b82f6;
                  outline-offset: 2px;
                  transition: outline 0.15s ease;
                }

                /* Smooth accordion/collapsible animations */
                .scalar-app [data-state="open"] {
                  animation: slideDown 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                }

                .scalar-app [data-state="closed"] {
                  animation: slideUp 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                }

                @keyframes slideDown {
                  from {
                    height: 0;
                    opacity: 0;
                  }
                  to {
                    height: var(--radix-accordion-content-height);
                    opacity: 1;
                  }
                }

                @keyframes slideUp {
                  from {
                    height: var(--radix-accordion-content-height);
                    opacity: 1;
                  }
                  to {
                    height: 0;
                    opacity: 0;
                  }
                }

                /* Optimize text rendering */
                .scalar-app {
                  text-rendering: optimizeLegibility;
                  -webkit-font-smoothing: antialiased;
                  -moz-osx-font-smoothing: grayscale;
                }

                /* Prevent unnecessary repaints */
                .scalar-app .sticky,
                .scalar-app [position="sticky"] {
                  will-change: transform;
                }
              `,
              darkMode: false,
              hideDownloadButton: false,
              hideTestRequestButton: false,
              isEditable: false,
              layout: "modern",
              showSidebar: true,
              theme: "default",
              withDefaultFonts: true,
            },
            spec: {
              content: parsedSpec,
            },
          };

          window.Scalar.createApiReference(container, config);
        } catch (scalarError) {
          console.error("Failed to create Scalar API reference:", scalarError);
          const errorMessage = scalarError instanceof Error ? scalarError.message : "Unknown error";
          container.innerHTML = `
            <div class="text-center py-8">
              <p class="text-red-500">Failed to load API documentation</p>
              <p class="text-gray-500 text-sm mt-2">Error: ${errorMessage}</p>
            </div>
          `;
        }
      });
    } catch (error) {
      console.error("Failed to initialize Scalar:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      container.innerHTML = `
        <div class="text-center py-8">
          <p class="text-red-500">Failed to load API documentation</p>
          <p class="text-gray-500 text-sm mt-2">Error: ${errorMessage}</p>
        </div>
      `;
    }
  }, [isScalarLoaded, specData]);

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Loading API Documentation...</CardTitle>
          <CardDescription>Fetching specification for v{version}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-500"></div>
          </div>
          {/* Loading skeleton */}
          <div className="animate-pulse space-y-4">
            <div className="h-4 w-3/4 rounded bg-gray-200"></div>
            <div className="h-4 w-1/2 rounded bg-gray-200"></div>
            <div className="h-32 rounded bg-gray-200"></div>
            <div className="h-4 w-2/3 rounded bg-gray-200"></div>
            <div className="h-20 rounded bg-gray-200"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !specData?.spec) {
    const errorMessage = error instanceof Error ? error.message : "Specification not found";
    return (
      <Card>
        <CardHeader>
          <CardTitle>Failed to Load API Documentation</CardTitle>
          <CardDescription>Unable to fetch specification for v{version}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="py-8 text-center">
            <p className="text-red-500">Error loading API specification</p>
            <p className="mt-2 text-sm text-gray-500">{errorMessage}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div
          className="min-h-[600px] w-full"
          ref={containerRef}
          style={{
            border: "none",
            borderRadius: "8px",
            contain: "layout style paint",
            isolation: "isolate",
            willChange: "scroll-position",
          }}
        />
      </CardContent>
    </Card>
  );
}

// Extend the Window interface to include Scalar
declare global {
  interface Window {
    Scalar: {
      createApiReference: (element: HTMLElement, config: ScalarConfig) => void;
    };
  }
}
