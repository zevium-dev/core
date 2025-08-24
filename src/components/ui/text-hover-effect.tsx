"use client";
import * as m from "motion/react-m";
import { useEffect, useRef, useState } from "react";

export const TextHoverEffect = ({ duration, text }: { automatic?: boolean; duration?: number; text: string }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [cursor, setCursor] = useState({ x: 0 as null | number, y: 0 as null | number });
  const [hovered, setHovered] = useState(false);
  const [maskPosition, setMaskPosition] = useState({ cx: "50%", cy: "50%" });

  useEffect(() => {
    if (svgRef.current && cursor.x !== null && cursor.y !== null) {
      const svgRect = svgRef.current.getBoundingClientRect();
      const cxPercentage = ((cursor.x - svgRect.left) / svgRect.width) * 100;
      const cyPercentage = ((cursor.y - svgRect.top) / svgRect.height) * 100;
      // eslint-disable-next-line @eslint-react/hooks-extra/no-direct-set-state-in-use-effect
      setMaskPosition({
        cx: `${cxPercentage}%`,
        cy: `${cyPercentage}%`,
      });
    }
  }, [cursor]);

  return (
    <svg
      className="select-none"
      height="100%"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseMove={(e) => setCursor({ x: e.clientX, y: e.clientY })}
      ref={svgRef}
      viewBox="0 0 300 100"
      width="100%"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient cx="50%" cy="50%" gradientUnits="userSpaceOnUse" id="textGradient" r="25%">
          {hovered && (
            <>
              <stop offset="0%" stopColor="#eab308" />
              <stop offset="25%" stopColor="#ef4444" />
              <stop offset="50%" stopColor="#3b82f6" />
              <stop offset="75%" stopColor="#06b6d4" />
              <stop offset="100%" stopColor="#8b5cf6" />
            </>
          )}
        </linearGradient>

        <m.radialGradient
          animate={maskPosition}
          gradientUnits="userSpaceOnUse"
          id="revealMask"
          initial={{ cx: "50%", cy: "50%" }}
          r="20%"
          transition={{ duration: duration ?? 0, ease: "easeOut" }}

          // example for a smoother animation below

          //   transition={{
          //     type: "spring",
          //     stiffness: 300,
          //     damping: 50,
          //   }}
        >
          <stop offset="0%" stopColor="white" />
          <stop offset="100%" stopColor="black" />
        </m.radialGradient>
        <mask id="textMask">
          <rect fill="url(#revealMask)" height="100%" width="100%" x="0" y="0" />
        </mask>
      </defs>
      <text
        className="fill-transparent stroke-neutral-50 font-[helvetica] text-7xl font-bold dark:stroke-neutral-700"
        dominantBaseline="middle"
        strokeWidth="1"
        style={{ opacity: hovered ? 0.7 : 0 }}
        textAnchor="middle"
        x="50%"
        y="50%"
      >
        {text}
      </text>
      <m.text
        animate={{
          strokeDasharray: 1000,
          strokeDashoffset: 0,
        }}
        className="fill-transparent stroke-neutral-200 font-[helvetica] text-7xl font-bold dark:stroke-neutral-800"
        dominantBaseline="middle"
        initial={{ strokeDasharray: 1000, strokeDashoffset: 1000 }}
        strokeWidth="1"
        textAnchor="middle"
        transition={{
          duration: 4,
          ease: "easeInOut",
        }}
        x="50%"
        y="50%"
      >
        {text}
      </m.text>
      <text
        className="fill-transparent font-[helvetica] text-7xl font-bold"
        dominantBaseline="middle"
        mask="url(#textMask)"
        stroke="url(#textGradient)"
        strokeWidth="1"
        textAnchor="middle"
        x="50%"
        y="50%"
      >
        {text}
      </text>
    </svg>
  );
};
