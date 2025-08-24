import * as AvatarPrimitive from "@radix-ui/react-avatar";
import * as React from "react";

import { cn } from "~/lib/utils/index";

function Avatar({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      className={cn("outline-border relative flex size-10 shrink-0 overflow-hidden rounded-full outline-2", className)}
      data-slot="avatar"
      {...props}
    />
  );
}

function AvatarFallback({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn(
        "bg-secondary-background text-foreground font-base flex size-full items-center justify-center rounded-full",
        className,
      )}
      data-slot="avatar-fallback"
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image className={cn("aspect-square size-full", className)} data-slot="avatar-image" {...props} />
  );
}

export { Avatar, AvatarFallback, AvatarImage };
