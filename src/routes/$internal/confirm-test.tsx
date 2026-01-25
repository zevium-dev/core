import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useConfirm } from "~/hooks/use-confirm";

export const Route = createFileRoute("/$internal/confirm-test")({
  component: ConfirmTest,
});

function ConfirmTest() {
  const confirm = useConfirm();
  const [events, setEvents] = useState<Array<{ id: number; message: string }>>([]);
  const nextEventIdRef = useRef(1);

  const log = (message: string) => {
    const id = nextEventIdRef.current;
    nextEventIdRef.current += 1;
    setEvents((prev) => [...prev, { id, message }]);
  };

  const confirmOnce = () => {
    void confirm({
      confirmText: "Confirm",
      description: "This is a single confirm call.",
      title: "Confirm once",
    }).then((ok) => {
      log(`Confirm once: ${ok ? "confirmed" : "cancelled"}`);
    });
  };

  const confirmTwiceSequential = () => {
    void confirm({
      confirmText: "Next",
      description: "Step 1 of 2. Close this to continue.",
      title: "Sequential confirm (1/2)",
    })
      .then((ok1) => {
        log(`Sequential 1: ${ok1 ? "confirmed" : "cancelled"}`);
        return confirm({
          confirmText: "Finish",
          description: "Step 2 of 2.",
          title: "Sequential confirm (2/2)",
        });
      })
      .then((ok2) => {
        log(`Sequential 2: ${ok2 ? "confirmed" : "cancelled"}`);
      });
  };

  const confirmBurst3 = () => {
    void confirm({
      confirmText: "Continue",
      description: "First dialog in a burst of 3.",
      title: "Burst (1/3)",
    }).then((ok) => {
      log(`Burst 1: ${ok ? "confirmed" : "cancelled"}`);
    });

    void confirm({
      confirmText: "Continue",
      description: "Second dialog in a burst of 3.",
      title: "Burst (2/3)",
    }).then((ok) => {
      log(`Burst 2: ${ok ? "confirmed" : "cancelled"}`);
    });

    void confirm({
      confirmText: "Delete",
      description: "Third dialog in a burst of 3 (destructive).",
      destructive: true,
      title: "Burst (3/3)",
    }).then((ok) => {
      log(`Burst 3: ${ok ? "confirmed" : "cancelled"}`);
    });
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-3xl font-bold">useConfirm Test</h1>
          <p className="mt-2 text-muted-foreground">
            Verifies queued confirms (multiple invocations) using the global AlertDialog.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 rounded-lg border border-border p-4">
          <button
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            onClick={confirmOnce}
            type="button"
          >
            Confirm once
          </button>
          <button
            className="rounded-md bg-secondary px-3 py-2 text-sm font-medium text-secondary-foreground"
            onClick={confirmTwiceSequential}
            type="button"
          >
            Confirm twice (sequential)
          </button>
          <button
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium"
            onClick={confirmBurst3}
            type="button"
          >
            Burst 3 confirms
          </button>
          <button
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium"
            onClick={() => {
              setEvents([]);
            }}
            type="button"
          >
            Clear log
          </button>
        </div>

        <div className="rounded-lg border border-border p-4">
          <h2 className="text-lg font-semibold">Event log</h2>
          {events.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No events yet.</p>}
          {events.length > 0 && (
            <ol className="mt-2 list-inside list-decimal space-y-1 text-sm">
              {events.map((e) => (
                <li key={e.id}>{e.message}</li>
              ))}
            </ol>
          )}
        </div>

        <div className="rounded-lg border border-border p-4">
          <h2 className="text-lg font-semibold">What to test</h2>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
            <li>Click "Burst 3 confirms".</li>
            <li>Resolve dialogs in any combination of Cancel/Confirm.</li>
            <li>Dialogs should appear one-by-one (queue), not overlap.</li>
            <li>Event log should contain 3 results in order.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
