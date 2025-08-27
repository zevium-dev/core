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
        // remove fixed width so the card will size to its grid cell; reduce padding for compact layout
        "rounded-base border-border bg-main font-base shadow-shadow overflow-hidden border-2",
        className,
      )}
    >
      <img alt="image" className="w-full object-cover aspect-video" src={imageUrl} />
      <figcaption className="text-main-foreground border-border border-t-2 px-3 py-2 text-sm">{caption}</figcaption>
    </figure>
  );
}
