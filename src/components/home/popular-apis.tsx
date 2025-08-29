import { Star } from "lucide-react";

interface ApiCard {
  description: string;
  initials: string;
  name: string;
  pricing: "Free" | "Paid";
  rating: number;
  reviews: number;
}

const popular: Array<ApiCard> = [
  {
    description: "Resolve IP → country, city, ASN.",
    initials: "G",
    name: "GeoIP API",
    pricing: "Free",
    rating: 4.8,
    reviews: 1241,
  },
  {
    description: "Syntax, MX, disposable checks.",
    initials: "E",
    name: "Email Verify",
    pricing: "Paid",
    rating: 4.7,
    reviews: 987,
  },
  {
    description: "Realtime and historical FX.",
    initials: "C",
    name: "Currency FX",
    pricing: "Paid",
    rating: 4.9,
    reviews: 1632,
  },
  {
    description: "Global current conditions.",
    initials: "W",
    name: "Weather Lite",
    pricing: "Free",
    rating: 4.6,
    reviews: 842,
  },
  {
    description: "Transactional messaging at scale.",
    initials: "S",
    name: "SMS Gateway",
    pricing: "Paid",
    rating: 4.8,
    reviews: 713,
  },
  {
    description: "Fast extractive summaries.",
    initials: "T",
    name: "Text Summarize",
    pricing: "Free",
    rating: 4.5,
    reviews: 501,
  },
];

export function PopularApis() {
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {popular.map((api) => (
        <article className="group hover:bg-accent/40 rounded-lg border p-5 transition-colors" key={api.name}>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-muted text-foreground/80 grid size-9 place-items-center rounded-md text-sm font-semibold">
                {api.initials}
              </div>
              <h3 className="text-foreground text-sm font-medium">{api.name}</h3>
            </div>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                api.pricing === "Free" ? "text-foreground" : "text-foreground/90"
              }`}
            >
              {api.pricing}
            </span>
          </div>
          <p className="text-muted-foreground line-clamp-2 text-sm">{api.description}</p>
          <div className="text-foreground/80 mt-4 flex items-center gap-2 text-xs">
            <Star className="text-primary size-4 fill-current" />
            <span className="font-medium">{api.rating.toFixed(1)}</span>
            <span className="text-muted-foreground">({api.reviews.toLocaleString()})</span>
          </div>
        </article>
      ))}
    </div>
  );
}
