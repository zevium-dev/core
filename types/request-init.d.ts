declare global {
  interface RequestInit {
    /**
     * Required for streaming request bodies (e.g. proxying `request.body` via fetch)
     * in Node.js / edge runtimes like Cloudflare Workers.
     *
     * This augmentation exists because TypeScript's bundled DOM lib types do not
     * yet declare `duplex` on `RequestInit`. We add it once here instead of
     * scattering `// @ts-expect-error` comments at every streaming fetch call site
     * (src/routes/api/proxy/$.ts, src/routes/api/posthog/$.ts).
     *
     * Tracking: https://github.com/microsoft/TypeScript-DOM-lib-editor/issues/
     */
    duplex?: "half";
  }
}

export {};
