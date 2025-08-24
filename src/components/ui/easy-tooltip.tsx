import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";

export type EasyTooltipProps = { asChild?: boolean; label: string } & React.ComponentProps<typeof Tooltip>;

export const EasyTooltip = ({ asChild = false, children, label, ...props }: EasyTooltipProps) => {
  return (
    <TooltipProvider>
      <Tooltip {...props}>
        <TooltipTrigger asChild={asChild}>{children}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
