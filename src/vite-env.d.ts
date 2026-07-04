/// <reference types="vite/client" />
/// <reference types="@vitest/browser/context" />

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface ImportMetaEnv {
  // Client
  VITE_PUBLIC_POLAR_TOPUP_PRODUCTS?: string;
  VITE_PUBLIC_POSTHOG_KEY?: string;
  VITE_PUBLIC_URL?: string;
}

interface ViteTypeOptions {
  strictImportMetaEnv: unknown;
}
