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
        "z-10 flex size-12 items-center justify-center rounded-full border-2 border-gray-300/30 bg-transparent p-3 shadow-lg backdrop-blur-sm dark:border-gray-600/30",
        className,
      )}
      ref={ref}
    >
      <div className="text-gray-700 dark:text-gray-400">{children}</div>
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
      className={cn("relative flex h-[500px] w-full items-center justify-center overflow-hidden p-10", className)}
      ref={containerRef}
    >
      <div className="flex size-full max-w-lg flex-row items-stretch justify-between gap-10">
        <div className="flex flex-col justify-center">
          <Circle ref={div7Ref}>
            <Users className="h-6 w-6" />
          </Circle>
        </div>
        <div className="flex flex-col justify-center">
          <Circle className="size-16" ref={div6Ref}>
            <img alt="Zevium" className="h-8 w-8" src="/icon.png" />
          </Circle>
        </div>
        <div className="flex flex-col justify-center gap-2">
          <Circle ref={div1Ref}>
            <Folder className="h-6 w-6" />
          </Circle>
          <Circle ref={div2Ref}>
            <FileText className="h-6 w-6" />
          </Circle>
          <Circle ref={div3Ref}>
            <MessageSquare className="h-6 w-6" />
          </Circle>
          <Circle ref={div4Ref}>
            <Globe className="h-6 w-6" />
          </Circle>
          <Circle ref={div5Ref}>
            <Code className="h-6 w-6" />
          </Circle>
        </div>
      </div>

      {/* AnimatedBeams */}
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div1Ref}
        pathColor="rgb(156, 163, 175)"
        pathOpacity={0.4}
        toRef={div6Ref}
      />
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div2Ref}
        pathColor="rgb(156, 163, 175)"
        pathOpacity={0.4}
        toRef={div6Ref}
      />
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div3Ref}
        pathColor="rgb(156, 163, 175)"
        pathOpacity={0.4}
        toRef={div6Ref}
      />
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div4Ref}
        pathColor="rgb(156, 163, 175)"
        pathOpacity={0.4}
        toRef={div6Ref}
      />
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div5Ref}
        pathColor="rgb(156, 163, 175)"
        pathOpacity={0.4}
        toRef={div6Ref}
      />
      <AnimatedBeam
        containerRef={containerRef}
        duration={3}
        fromRef={div6Ref}
        pathColor="rgb(156, 163, 175)"
        pathOpacity={0.4}
        toRef={div7Ref}
      />
    </div>
  );
}
