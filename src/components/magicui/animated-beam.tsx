"use client";

import { m } from "motion/react";
import { RefObject, useEffect, useId, useRef, useState } from "react";

import { cn } from "~/lib/utils/index";

export interface AnimatedBeamProps {
  className?: string;
  containerRef: RefObject<HTMLElement | null>; // Container ref
  curvature?: number;
  delay?: number;
  duration?: number;
  endXOffset?: number;
  endYOffset?: number;
  fromRef: RefObject<HTMLElement | null>;
  gradientStartColor?: string;
  gradientStopColor?: string;
  pathColor?: string;
  pathOpacity?: number;
  pathWidth?: number;
  reverse?: boolean;
  startXOffset?: number;
  startYOffset?: number;
  toRef: RefObject<HTMLElement | null>;
}

export const AnimatedBeam: React.FC<AnimatedBeamProps> = ({
  className,
  containerRef,
  curvature = 0,
  delay = 0,
  duration: durationProp,
  endXOffset = 0,
  endYOffset = 0,
  fromRef,
  gradientStartColor = "#ffaa40",
  gradientStopColor = "#9c40ff",
  pathColor = "gray",
  pathOpacity = 0.2,
  pathWidth = 2,
  reverse = false, // Include the reverse prop
  startXOffset = 0,
  startYOffset = 0,
  toRef,
}) => {
  const id = useId();
  const pathRef = useRef<SVGPathElement>(null);
  const path2Ref = useRef<SVGPathElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [duration] = useState(() => durationProp ?? Math.random() * 3 + 4);

  // Calculate the gradient coordinates based on the reverse prop
  const gradientCoordinates = reverse
    ? {
        x1: ["90%", "-10%"],
        x2: ["100%", "0%"],
        y1: ["0%", "0%"],
        y2: ["0%", "0%"],
      }
    : {
        x1: ["10%", "110%"],
        x2: ["0%", "100%"],
        y1: ["0%", "0%"],
        y2: ["0%", "0%"],
      };

  useEffect(() => {
    const updatePath = () => {
      if (
        !containerRef.current ||
        !fromRef.current ||
        !toRef.current ||
        !svgRef.current ||
        !pathRef.current ||
        !path2Ref.current
      ) {
        return;
      }
      const containerRect = containerRef.current.getBoundingClientRect();
      const rectA = fromRef.current.getBoundingClientRect();
      const rectB = toRef.current.getBoundingClientRect();

      const svgWidth = containerRect.width;
      const svgHeight = containerRect.height;

      svgRef.current.setAttribute("width", String(svgWidth));
      svgRef.current.setAttribute("height", String(svgHeight));
      svgRef.current.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);

      const startX = rectA.left - containerRect.left + rectA.width / 2 + startXOffset;
      const startY = rectA.top - containerRect.top + rectA.height / 2 + startYOffset;
      const endX = rectB.left - containerRect.left + rectB.width / 2 + endXOffset;
      const endY = rectB.top - containerRect.top + rectB.height / 2 + endYOffset;

      const controlY = startY - curvature;
      const d = `M ${startX},${startY} Q ${(startX + endX) / 2},${controlY} ${endX},${endY}`;

      pathRef.current.setAttribute("d", d);
      path2Ref.current.setAttribute("d", d);
    };

    const resizeObserver = new ResizeObserver(() => {
      updatePath();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    updatePath();

    return () => {
      resizeObserver.disconnect();
    };
  }, [containerRef, fromRef, toRef, curvature, startXOffset, startYOffset, endXOffset, endYOffset]);

  return (
    <svg
      className={cn(
        `
        pointer-events-none absolute top-0 left-0 transform-gpu stroke-2
      `,
        className,
      )}
      fill="none"
      height={0}
      ref={svgRef}
      viewBox="0 0 0 0"
      width={0}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d=""
        ref={pathRef}
        stroke={pathColor}
        strokeLinecap="round"
        strokeOpacity={pathOpacity}
        strokeWidth={pathWidth}
      />
      <path
        d=""
        ref={path2Ref}
        stroke={`url(#${id})`}
        strokeLinecap="round"
        strokeOpacity="1"
        strokeWidth={pathWidth}
      />
      <defs>
        <m.linearGradient
          animate={{
            x1: gradientCoordinates.x1,
            x2: gradientCoordinates.x2,
            y1: gradientCoordinates.y1,
            y2: gradientCoordinates.y2,
          }}
          className="transform-gpu"
          gradientUnits={"userSpaceOnUse"}
          id={id}
          initial={{
            x1: "0%",
            x2: "0%",
            y1: "0%",
            y2: "0%",
          }}
          transition={{
            delay,
            duration,
            ease: [0.16, 1, 0.3, 1], // https://easings.net/#easeOutExpo
            repeat: Infinity,
            repeatDelay: 0,
          }}
        >
          <stop stopColor={gradientStartColor} stopOpacity="0"></stop>
          <stop stopColor={gradientStartColor}></stop>
          <stop offset="32.5%" stopColor={gradientStopColor}></stop>
          <stop offset="100%" stopColor={gradientStopColor} stopOpacity="0"></stop>
        </m.linearGradient>
      </defs>
    </svg>
  );
};
