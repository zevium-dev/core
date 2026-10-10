/// <reference lib="webworker" />

import { parseYamlInWorker } from "./spec-yaml.worker-core";

self.onmessage = (event: MessageEvent<{ text: string }>) => {
  self.postMessage(parseYamlInWorker(event.data.text));
};

// Module loading is outside the parser CPU budget.
self.postMessage({ ready: true });

export {};
