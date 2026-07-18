type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="78 128 356 256"
      fill="currentColor"
    >
      <g transform="translate(0 32)">
        <path d="M130 96h304L338 264h-92l55-96H89l41-72Z" />
        <path d="M174 184h92l-55 96h212l-41 72H78l96-168Z" />
      </g>
    </svg>
  );
}
