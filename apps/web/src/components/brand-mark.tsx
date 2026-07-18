type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 512 512"
      fill="currentColor"
    >
      <path d="M130 96h304L338 264h-92l55-96H89l41-72Z" />
      <path d="M174 184h92l-55 96h212l-41 72H78l96-168Z" />
    </svg>
  );
}
