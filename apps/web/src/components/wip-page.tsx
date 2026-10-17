import { useId, type CSSProperties, type ReactNode } from "react";

import { PublicHeader } from "#/components/public-header";
import { SiteFooter } from "#/components/site-footer";
import { Badge } from "#/components/ui/badge";
import { useHydratedReducedMotion } from "#/hooks/use-hydrated-reduced-motion";
import { cn } from "#/lib/utils";

export type WipIllustrationVariant = "privacy" | "terms" | "support";

type WipPageProps = {
  title: string;
  lede: string;
  illustration: WipIllustrationVariant;
  children?: ReactNode;
};

/**
 * Public placeholder for pages whose content is still being written
 * (privacy, terms, support). Owner decision 2026-10-17: no invented legal
 * text; show what is true now instead.
 */
export function WipPage({ title, lede, illustration, children }: WipPageProps) {
  const headingId = useId();
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PublicHeader />
      <main
        id="main-content"
        style={{ viewTransitionName: "main-content" }}
        tabIndex={-1}
        className="content-enter flex-1 outline-none"
      >
        <section
          aria-labelledby={headingId}
          className="mx-auto flex max-w-xl flex-col items-center gap-5 px-4 py-16 text-center sm:py-24"
        >
          <WipIllustration
            variant={illustration}
            className="mb-2 w-48 text-muted-foreground sm:w-56"
          />
          <Badge variant="outline">In progress</Badge>
          <h1
            id={headingId}
            className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-4xl"
          >
            {title}
          </h1>
          <p className="text-lg text-muted-foreground">{lede}</p>
          {children}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

/** Stagger index for CSS delays: `calc(var(--i) * var(--stagger))`. */
function step(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

/**
 * Decorative, one-shot illustration. Final state is the base style; CSS
 * keyframes only animate *from* an earlier state, so `animation: none`
 * (reduced motion, pre-hydration media query or `data-static`) is the
 * finished drawing. Transform/opacity only.
 */
export function WipIllustration({
  variant,
  className,
}: {
  variant: WipIllustrationVariant;
  className?: string;
}) {
  const reduce = useHydratedReducedMotion();
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 200 160"
      data-variant={variant}
      data-static={reduce ? "" : undefined}
      className={cn("wip-art h-auto", className)}
    >
      {variant === "support" ? <SupportArt /> : <DocumentArt />}
      {variant === "privacy" ? <PrivacySeal /> : null}
      {variant === "terms" ? <TermsSignature /> : null}
    </svg>
  );
}

const BODY_LINES = [72, 64, 70, 52, 60] as const;

function DocumentArt() {
  return (
    <g className="wip-rise">
      <rect
        x="50"
        y="14"
        width="100"
        height="128"
        rx="8"
        strokeWidth="1.5"
        className="fill-card stroke-border"
      />
      <rect
        x="64"
        y="30"
        width="48"
        height="6"
        rx="3"
        className="wip-write fill-foreground/80"
        style={step(2)}
      />
      {BODY_LINES.map((width, i) => (
        <rect
          key={i}
          x="64"
          y={48 + i * 11}
          width={width}
          height="4"
          rx="2"
          className="wip-write fill-muted-foreground/40"
          style={step(3 + i)}
        />
      ))}
    </g>
  );
}

function PrivacySeal() {
  return (
    <g className="text-primary">
      <g className="wip-pop" style={step(9)}>
        <circle
          cx="146"
          cy="118"
          r="20"
          strokeWidth="2"
          className="fill-background stroke-current"
        />
        <rect
          x="137"
          y="116"
          width="18"
          height="13"
          rx="2.5"
          className="fill-current"
        />
        <circle cx="146" cy="122" r="1.75" className="fill-background" />
      </g>
      <path
        d="M140.5 116v-4a5.5 5.5 0 0 1 11 0v4"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="wip-latch stroke-current"
        style={step(12)}
      />
    </g>
  );
}

function TermsSignature() {
  const maskId = useId();
  return (
    <g className="text-primary">
      <line
        x1="64"
        y1="124"
        x2="128"
        y2="124"
        strokeWidth="1"
        strokeDasharray="2 3"
        className="stroke-border"
      />
      <mask id={maskId} maskUnits="userSpaceOnUse">
        <rect
          x="62"
          y="100"
          width="66"
          height="24"
          fill="white"
          className="wip-sign"
          style={step(9)}
        />
      </mask>
      <path
        d="M66 117c5-9 9-11 11-4s5 7 8-2 7-10 10-1 6 8 11-3 8-6 14 3"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        mask={`url(#${maskId})`}
        className="stroke-current"
      />
      <g transform="translate(120 113)">
        <g className="wip-pen" style={step(9)}>
          <path
            d="M0 0l2.5-8.5L16-22a2.8 2.8 0 0 1 4 4L6.5-4.5Z"
            strokeWidth="1.5"
            strokeLinejoin="round"
            className="fill-background stroke-current"
          />
        </g>
      </g>
    </g>
  );
}

function SupportArt() {
  return (
    <g className="text-primary">
      <g className="wip-rise">
        <path
          d="M82 58h36a12 12 0 0 1 12 12v12a12 12 0 0 1-12 12H94l-10 9v-9h-2a12 12 0 0 1-12-12V70a12 12 0 0 1 12-12Z"
          strokeWidth="1.5"
          strokeLinejoin="round"
          className="fill-card stroke-border"
        />
      </g>
      {[88, 100, 112].map((cx, i) => (
        <circle
          key={cx}
          cx={cx}
          cy="76"
          r="3.5"
          className="wip-pop fill-current"
          style={step(4 + i * 2)}
        />
      ))}
      <g
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-current"
      >
        <path
          d="M58.4 52A48 48 0 0 0 58.4 100M141.6 52A48 48 0 0 1 141.6 100"
          className="wip-signal"
          style={step(10)}
        />
        <path
          d="M44.6 44A64 64 0 0 0 44.6 108M155.4 44A64 64 0 0 1 155.4 108"
          className="wip-signal opacity-50"
          style={step(13)}
        />
      </g>
    </g>
  );
}
