import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";

export type CatalogueSort = "newest" | "name" | "cheapest";

const LABELS: Record<CatalogueSort, string> = {
  newest: "Newest",
  name: "Name",
  cheapest: "Cheapest",
};

export function CatalogueSortSelect({
  value,
  onValueChange,
}: {
  value: CatalogueSort;
  onValueChange: (value: CatalogueSort) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as CatalogueSort)}
    >
      <SelectTrigger
        id="catalogue-sort"
        className="w-full"
        aria-label="Sort catalogue"
      >
        <SelectValue>{LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="newest">Newest</SelectItem>
          <SelectItem value="name">Name</SelectItem>
          <SelectItem value="cheapest">Cheapest</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
