import { useEffect } from "react";

export function Broken({ ready }: { ready: boolean }) {
  if (ready) {
    useEffect(() => undefined, []);
  }
  return <img src="/missing-alt.png" />;
}

eval("globalThis.compromised = true");
