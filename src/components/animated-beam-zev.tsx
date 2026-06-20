import { Code, FileText, Folder, Globe, MessageSquare, Users } from "lucide-react";
import React, { useRef } from "react";

import { AnimatedBeam } from "~/components/magicui/animated-beam";
import { cn } from "~/lib/utils";

const Circle = ({
  children,
  className,
  ref,
}: { children?: React.ReactNode; className?: string } & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  return (
    <div
      className={cn(
        `
          z-10 flex size-12 items-center justify-center rounded-full border-2
          border-border/30 bg-transparent p-3 shadow-lg backdrop-blur-sm
        `,
        className,
      )}
      ref={ref}
    >
      <div className="text-muted-foreground">{children}</div>
    </div>
  );
};

Circle.displayName = "Circle";

export function AnimatedBeamZev({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const div1Ref = useRef<HTMLDivElement>(null);
  const div2Ref = useRef<HTMLDivElement>(null);
  const div3Ref = useRef<HTMLDivElement>(null);
  const div4Ref = useRef<HTMLDivElement>(null);
  const div5Ref = useRef<HTMLDivElement>(null);
  const div6Ref = useRef<HTMLDivElement>(null);
  const div7Ref = useRef<HTMLDivElement>(null);

  return (
    <div
      className={cn(
        `
        relative flex h-[500px] w-full items-center justify-center
        overflow-hidden p-10
      `,
        className,
      )}
      ref={containerRef}
    >
      <div
        className={`
        flex size-full max-w-lg flex-row items-stretch justify-between gap-10
      `}
      >
        <div className="flex flex-col justify-center">
          <Circle ref={div7Ref}>
            <Users className="size-6" />
          </Circle>
        </div>
        <div className="flex flex-col justify-center">
          <Circle className="size-16" ref={div6Ref}>
            <img alt="Zevium" className="size-8" src="/icon.png" />
          </Circle>
        </div>
        <div className="flex flex-col justify-center gap-2">
          <Circle ref={div1Ref}>
            <Folder className="size-6" />
          </Circle>
          <Circle ref={div2Ref}>
            <FileText className="size-6" />
          </Circle>
          <Circle ref={div3Ref}>
            <MessageSquare className="size-6" />
          </Circle>
          <Circle ref={div4Ref}>
            <Globe className="size-6" />
          </Circle>
          <Circle ref={div5Ref}>
            <Code className="size-6" />
          </Circle>
        </div>
      </div>

      {/* AnimatedBeams */}
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div1Ref}
        pathColor="hsl(var(--muted-foreground))"
        pathOpacity={0.4}
        toRef={div6Ref}
      />
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div2Ref}
        pathColor="hsl(var(--muted-foreground))"
        pathOpacity={0.4}
        toRef={div6Ref}
      />
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div3Ref}
        pathColor="hsl(var(--muted-foreground))"
        pathOpacity={0.4}
        toRef={div6Ref}
      />
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div4Ref}
        pathColor="hsl(var(--muted-foreground))"
        pathOpacity={0.4}
        toRef={div6Ref}
      />
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div5Ref}
        pathColor="hsl(var(--muted-foreground))"
        pathOpacity={0.4}
        toRef={div6Ref}
      />
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div6Ref}
        pathColor="hsl(var(--muted-foreground))"
        pathOpacity={0.4}
        toRef={div7Ref}
      />
    </div>
  );
}
