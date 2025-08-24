/// <reference types="vite/client" />

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface ImportMetaEnv {
  // Client
  VITE_PUBLIC_POSTHOG_KEY?: string;
}

interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}
