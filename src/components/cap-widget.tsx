import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "./ui/skeleton";

export const CapWidget = () => {
  const { isPending } = useQuery({
    queryFn: async () => {
      // @ts-expect-error - Cap widget does not have types
      await import("@cap.js/widget");
      return true;
    },
    queryKey: ["cap-lib"],
  });

  if (isPending) return <Skeleton className="h-[30px] w-[160px] rounded-full" />;

  // @ts-expect-error - JSX element type 'cap-widget' is not a constructor function for JSX elements.
  return <cap-widget data-cap-api-endpoint="/api/cap/" id="cap"></cap-widget>;
};
