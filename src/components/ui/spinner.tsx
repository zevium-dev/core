import { LoaderCircleIcon, type LucideProps } from "lucide-react";

import { cn } from "~/lib/utils";

export const Spinner: React.FC<LucideProps> = ({ className, ...props }) => {
  return <LoaderCircleIcon className={cn("animate-spin", className)} {...props} />;
};
