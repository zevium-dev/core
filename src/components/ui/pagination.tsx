import * as React from "react";

import { Button } from "~/components/ui/button";

interface Props {
  className?: string;
  onPageChange: (page: number) => void;
  page: number;
  pageSize: number;
  total: number; // total items
}

export function Pagination({ className, onPageChange, page, pageSize, total }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const canPrev = page > 1;
  const canNext = page < totalPages;

  const goPrev = React.useCallback(() => {
    if (canPrev) onPageChange(page - 1);
  }, [canPrev, onPageChange, page]);

  const goNext = React.useCallback(() => {
    if (canNext) onPageChange(page + 1);
  }, [canNext, onPageChange, page]);

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2">
        <Button disabled={!canPrev} onClick={goPrev} variant="neutral">
          Prev
        </Button>
        <div className="font-base text-sm text-foreground">
          Page {page} of {totalPages}
        </div>
        <Button disabled={!canNext} onClick={goNext} variant="neutral">
          Next
        </Button>
      </div>
    </div>
  );
}
