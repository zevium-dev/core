declare global {
  interface RequestInit {
    /**
     * Required for streaming request bodies in Node.js / edge runtimes.
     * Not yet included in TypeScript's DOM lib types.
     */
    duplex?: "half";
  }
}

export {};
