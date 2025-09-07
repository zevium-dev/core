/// <reference types="vite/client" />

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface ImportMetaEnv {
  // Client
  VITE_CONVEX_URL: string;
  VITE_PUBLIC_POSTHOG_KEY?: string;
  VITE_PUBLIC_URL?: string;
}

interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}
