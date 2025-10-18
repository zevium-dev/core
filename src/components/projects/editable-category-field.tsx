import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Edit3, Tag, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "~/components/ui/command";
import { Label } from "~/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useTRPC } from "~/lib/trpc";

interface EditableCategoryFieldProps {
  isPending?: boolean;
  onSave: (categoryId: null | string) => void;
  value: {
    categoryId: null | string;
    categoryName: null | string;
  };
}

export function EditableCategoryField({ isPending = false, onSave, value }: EditableCategoryFieldProps) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = React.useState<null | string>(value.categoryId);
  const [displayCategoryName, setDisplayCategoryName] = React.useState<null | string>(value.categoryName);
  const trpc = useTRPC();

  // Fetch categories
  const { data: categoriesData, isPending: categoriesPending } = useQuery(trpc.projectCategory.getAll.queryOptions({}));

  const categories = categoriesData?.categories ?? [];

  // Update selectedCategoryId when external value changes and we're not editing
  const previousValue = React.useRef(value.categoryId);
  if (previousValue.current !== value.categoryId && !isEditing) {
    setSelectedCategoryId(value.categoryId);
    setDisplayCategoryName(value.categoryName);
    previousValue.current = value.categoryId;
  }

  const handleSave = () => {
    const selectedCategory = categories.find((cat) => cat.id === selectedCategoryId);
    // Immediately update the display name for better UX
    setDisplayCategoryName(selectedCategory?.name ?? null);

    onSave(selectedCategoryId);
    setIsEditing(false);
    toast.success("Category updated successfully");
  };

  const handleCancel = () => {
    setSelectedCategoryId(value.categoryId);
    setDisplayCategoryName(value.categoryName);
    setIsEditing(false);
    setOpen(false);
  };

  const selectedCategory = categories.find((cat) => cat.id === selectedCategoryId);

  if (!isEditing) {
    return (
      <div className="group cursor-pointer" onClick={() => setIsEditing(true)}>
        <Label className="text-muted-foreground text-sm font-medium">Category</Label>
        <div className="border-muted-foreground/30 hover:border-muted-foreground/50 hover:bg-muted/50 mt-1 flex items-center gap-2 rounded-md border border-dashed p-3 transition-all">
          <Tag className="text-muted-foreground/60 h-4 w-4" />
          <span className="flex-1 text-sm">
            {displayCategoryName ?? <span className="text-muted-foreground italic">No category assigned</span>}
          </span>
          <Edit3 className="text-muted-foreground/60 group-hover:text-muted-foreground h-4 w-4 transition-colors" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Category</Label>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className="w-full justify-between font-normal"
            disabled={categoriesPending}
            role="combobox"
            variant="outline"
          >
            <div className="flex items-center gap-2">
              <Tag className="text-muted-foreground h-4 w-4" />
              {selectedCategory ? (
                <span>{selectedCategory.name}</span>
              ) : (
                <span className="text-muted-foreground">Select category...</span>
              )}
            </div>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[400px] p-0">
          <Command>
            <CommandInput placeholder="Search categories..." />
            <CommandList>
              <CommandEmpty>{categoriesPending ? "Loading categories..." : "No categories found."}</CommandEmpty>
              <CommandGroup>
                {/* Option to clear category */}
                <CommandItem
                  onSelect={() => {
                    setSelectedCategoryId(null);
                    setOpen(false);
                  }}
                  value="no-category"
                >
                  <div className="flex w-full items-center gap-2">
                    <X className="text-muted-foreground h-4 w-4" />
                    <div>
                      <div className="font-medium">No Category</div>
                      <div className="text-muted-foreground text-sm">Remove category assignment</div>
                    </div>
                  </div>
                </CommandItem>

                {/* Category options */}
                {categories.map((category) => (
                  <CommandItem
                    key={category.id}
                    onSelect={() => {
                      setSelectedCategoryId(category.id);
                      setOpen(false);
                    }}
                    value={category.name}
                  >
                    <div className="flex w-full items-center gap-2">
                      <Tag className="text-muted-foreground h-4 w-4" />
                      <div className="flex-1">
                        <div className="font-medium">{category.name}</div>
                        {category.description && (
                          <div className="text-muted-foreground line-clamp-1 text-sm">{category.description}</div>
                        )}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <div className="flex gap-2">
        <Button disabled={isPending} onClick={handleSave} size="sm">
          {isPending ? "Saving..." : "Save"}
        </Button>
        <Button disabled={isPending} onClick={handleCancel} size="sm" variant="outline">
          <X className="mr-2 h-4 w-4" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
