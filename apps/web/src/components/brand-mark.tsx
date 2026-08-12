type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      // Keep optical padding around path bounds. A tight viewBox clipped the
      // antialiased edges at small header sizes and made the mark read as a
      // broken glyph on high-DPI displays.
      viewBox="70 120 372 272"
      fill="currentColor"
    >
      <g transform="translate(0 32)">
        <path d="M130 96h304L338 264h-92l55-96H89l41-72Z" />
        <path d="M174 184h92l-55 96h212l-41 72H78l96-168Z" />
      </g>
    </svg>
  );
}
