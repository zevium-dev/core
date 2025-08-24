import { GripVertical } from "lucide-react";
import * as React from "react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "~/lib/utils/index";

function ResizableHandle({
  className,
  withHandle,
  ...props
}: {
  withHandle?: boolean;
} & React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle>) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      className={cn(
        "bg-border relative flex w-0.5 items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-black focus-visible:ring-offset-1 focus-visible:outline-none data-[panel-group-direction=vertical]:h-0.5 data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:translate-x-0 data-[panel-group-direction=vertical]:after:-translate-y-1/2 [&[data-panel-group-direction=vertical]>div]:rotate-90",
        className,
      )}
      data-slot="resizable-handle"
      {...props}
    >
      {withHandle && (
        <div className="rounded-base bg-border z-10 flex h-4 w-3 items-center justify-center border">
          <GripVertical className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.PanelResizeHandle>
  );
}

function ResizablePanel({ className, ...props }: React.ComponentProps<typeof ResizablePrimitive.Panel>) {
  return <ResizablePrimitive.Panel className={cn(className)} data-slot="resizable-panel" {...props} />;
}

function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      className={cn("font-base flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className)}
      data-slot="resizable-panel-group"
      {...props}
    />
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
