import { cn } from "~/lib/utils/index";

interface Props {
  caption: string;
  className?: string;
  imageUrl: string;
}

export default function ImageCard({ caption, className, imageUrl }: Props) {
  return (
    <figure
      className={cn(
        "rounded-base border-border bg-main font-base shadow-shadow w-[250px] overflow-hidden border-2",
        className,
      )}
    >
      <img alt="image" className="aspect-4/3 w-full" src={imageUrl} />
      <figcaption className="text-main-foreground border-border border-t-2 p-4">{caption}</figcaption>
    </figure>
  );
}
