"use client";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { type CheckoutParams, type CheckoutResult, type ProductItem, UsageModel } from "autumn-js";
import { useCustomer } from "autumn-js/react";
import { ArrowRight, ChevronDown, Loader2 } from "lucide-react";
import React, { useState } from "react";

import { Accordion, AccordionContent, AccordionItem } from "~/components/ui/accordion";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { getCheckoutContent } from "~/lib/autumn/checkout-content";
import { cn, formatDate } from "~/lib/utils/index";

export interface CheckoutDialogProps {
  checkoutParams?: CheckoutParams;
  checkoutResult: CheckoutResult;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const formatCurrency = ({ amount, currency }: { amount: number; currency: string }) => {
  return new Intl.NumberFormat("en-US", {
    currency: currency,
    style: "currency",
  }).format(amount);
};

export default function CheckoutDialog(params: CheckoutDialogProps) {
  const { attach } = useCustomer();
  const checkoutResult = params.checkoutResult;
  const [loading, setLoading] = useState(false);

  const { open, setOpen } = params;
  const { message, title } = getCheckoutContent(checkoutResult);

  const isFree = checkoutResult.product.properties.is_free;
  const isPaid = !isFree;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="gap-0 p-0 pt-4 text-sm text-foreground">
        <DialogTitle className="mb-1 px-6">{title}</DialogTitle>
        <div className="mt-1 mb-4 px-6 text-muted-foreground">{message}</div>

        {isPaid && <PriceInformation checkoutResult={checkoutResult} />}

        <DialogFooter className="flex flex-col justify-between gap-x-4 border-t bg-secondary py-2 pr-3 pl-6 shadow-inner sm:flex-row">
          <Button
            className="flex min-w-16 items-center gap-2"
            disabled={loading}
            onClick={async () => {
              setLoading(true);

              const options = checkoutResult.options.map((option) => {
                return {
                  featureId: option.feature_id,
                  quantity: option.quantity,
                };
              });

              await attach({
                productId: checkoutResult.product.id,
                ...(params.checkoutParams ?? {}),
                options,
              });
              setOpen(false);
              setLoading(false);
            }}
            size="sm"
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <>
                <span className="flex gap-1 whitespace-nowrap">Confirm</span>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CheckoutLines({ checkoutResult }: { checkoutResult: CheckoutResult }) {
  return (
    <Accordion collapsible type="single">
      <AccordionItem className="border-b-0" value="total">
        <CustomAccordionTrigger className="my-0 w-full justify-between border-none py-0">
          <div className="flex w-full cursor-pointer items-center justify-end gap-1">
            <p className="font-light text-muted-foreground">View details</p>
            <ChevronDown
              className="mt-0.5 rotate-90 text-muted-foreground transition-transform duration-200 ease-in-out"
              size={14}
            />
          </div>
        </CustomAccordionTrigger>
        <AccordionContent className="mt-2 mb-0 flex flex-col gap-2 pb-2">
          {checkoutResult.lines
            .filter((line) => line.amount !== 0)
            .map((line) => {
              const lineKey = `${line.description}-${line.amount}-${line.item.feature_id ?? "na"}`;
              return (
                <div className="flex justify-between" key={lineKey}>
                  <p className="text-muted-foreground">{line.description}</p>
                  <p className="text-muted-foreground">
                    {new Intl.NumberFormat("en-US", {
                      currency: checkoutResult.currency,
                      style: "currency",
                    }).format(line.amount)}
                  </p>
                </div>
              );
            })}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function CustomAccordionTrigger({
  children,
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        className={cn(
          `
            flex flex-1 items-start justify-between gap-4 rounded-md py-4
            text-left text-sm font-medium transition-all outline-none
            focus-visible:border-ring focus-visible:ring-[3px]
            focus-visible:ring-ring/50
            disabled:pointer-events-none disabled:opacity-50
            [&[data-state=open]_svg]:rotate-0
          `,
          className,
        )}
        data-slot="accordion-trigger"
        {...props}
      >
        {children}
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function DueAmounts({ checkoutResult }: { checkoutResult: CheckoutResult }) {
  const { next_cycle, product } = checkoutResult;
  const nextCycleAtStr = next_cycle ? formatDate(next_cycle.starts_at, { dateOnly: true }) : undefined;

  const hasUsagePrice = product.items.some((item) => item.usage_model === UsageModel.PayPerUse);

  const showNextCycle = next_cycle && next_cycle.total !== checkoutResult.total;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between">
        <div>
          <p className="text-md font-medium">Total due today</p>
        </div>

        <p className="text-md font-medium">
          {formatCurrency({
            amount: checkoutResult.total,
            currency: checkoutResult.currency,
          })}
        </p>
      </div>
      {showNextCycle && (
        <div className="flex justify-between text-muted-foreground">
          <div>
            <p className="text-md">Due next cycle ({nextCycleAtStr})</p>
          </div>
          <p className="text-md">
            {formatCurrency({
              amount: next_cycle.total,
              currency: checkoutResult.currency,
            })}
            {hasUsagePrice && <span> + usage prices</span>}
          </p>
        </div>
      )}
    </div>
  );
}

function PriceInformation({ checkoutResult }: { checkoutResult: CheckoutResult }) {
  return (
    <div className="mb-4 flex flex-col gap-4 px-6">
      <ProductItems checkoutResult={checkoutResult} />

      <div className="flex flex-col gap-2">
        {checkoutResult.has_prorations && checkoutResult.lines.length > 0 && (
          <CheckoutLines checkoutResult={checkoutResult} />
        )}
        <DueAmounts checkoutResult={checkoutResult} />
      </div>
    </div>
  );
}

function ProductItems({ checkoutResult }: { checkoutResult: CheckoutResult }) {
  const isUpdateQuantity = checkoutResult.product.scenario === "active" && checkoutResult.product.properties.updateable;

  const isOneOff = checkoutResult.product.properties.is_one_off;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Price</p>
      {checkoutResult.product.items
        .filter((item) => item.type !== "feature")
        .map((item) => {
          if (item.usage_model == UsageModel.Prepaid) {
            return (
              <PrepaidItem
                checkoutResult={checkoutResult}
                item={item}
                key={item.feature_id ?? item.display?.primary_text ?? "prepaid-item"}
              />
            );
          }

          if (isUpdateQuantity) {
            return null;
          }

          return (
            <div
              className="flex justify-between"
              key={item.feature_id ?? `${item.display?.primary_text}-${item.display?.secondary_text}`}
            >
              <p className="text-muted-foreground">{item.feature?.name ?? (isOneOff ? "Price" : "Subscription")}</p>
              <p>
                {item.display?.primary_text} {item.display?.secondary_text}
              </p>
            </div>
          );
        })}
    </div>
  );
}

const PrepaidItem = ({ checkoutResult, item }: { checkoutResult: CheckoutResult; item: ProductItem }) => {
  const { billing_units: billingUnits = 1, quantity = 0 } = item;
  const [quantityInput, setQuantityInput] = useState<string>((quantity / billingUnits).toString());
  const { checkout } = useCustomer();
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const scenario = checkoutResult.product.scenario;

  const handleSave = async () => {
    setLoading(true);
    try {
      const newOptions = checkoutResult.options
        .filter((option) => option.feature_id !== item.feature_id)
        .map((option) => {
          return {
            featureId: option.feature_id,
            quantity: option.quantity,
          };
        });

      if (item.feature_id) {
        newOptions.push({
          featureId: item.feature_id,
          quantity: Number(quantityInput) * billingUnits,
        });
      }

      const { error } = await checkout({
        dialog: CheckoutDialog,
        options: newOptions,
        productId: checkoutResult.product.id,
      });
      if (error) {
        console.error(error);
        return;
      }
    } catch (err: unknown) {
      console.error(err);
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };

  const disableSelection = scenario === "renew";

  return (
    <div className="flex justify-between gap-2">
      <div className="flex items-start gap-2">
        <p className="whitespace-nowrap text-muted-foreground">{item.feature?.name ?? "Feature"}</p>
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger
            className={cn(
              `
                flex shrink-0 items-center gap-1 rounded-md bg-accent/80 px-1
                py-0.5 text-xs text-muted-foreground
              `,
              !disableSelection && "hover:bg-accent hover:text-foreground",
            )}
            disabled={disableSelection}
          >
            Qty: {quantity}
            <ChevronDown size={12} />
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-80 flex-col gap-4 p-4 pt-3 text-sm">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{item.feature?.name ?? "Feature"}</p>
              <p className="text-muted-foreground">
                {item.display?.primary_text} {item.display?.secondary_text}
              </p>
            </div>

            <div className="flex items-end justify-between">
              <div className="flex items-center gap-2">
                <Input
                  className="h-7 w-16 focus:ring-2!"
                  onChange={(e) => setQuantityInput(e.target.value)}
                  value={quantityInput}
                />
                <p className="text-muted-foreground">
                  {billingUnits > 1 && `x ${billingUnits} `}
                  {item.feature?.name ?? "Feature"}
                </p>
              </div>

              <Button
                className="h-7! w-14 items-center border border-border bg-background text-sm text-foreground shadow-sm hover:bg-muted"
                disabled={loading}
                onClick={handleSave}
              >
                {loading ? <Loader2 className="size-4! animate-spin text-muted-foreground" /> : "Save"}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <p className="text-end">
        {item.display?.primary_text} {item.display?.secondary_text}
      </p>
    </div>
  );
};

export const PriceItem = ({
  children,
  className,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) => {
  return (
    <div
      className={cn(
        `
          flex flex-col justify-between gap-1 pb-4
          sm:h-7 sm:flex-row sm:items-center sm:gap-2 sm:pb-0
        `,
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
};

export const PricingDialogButton = ({
  children,
  className,
  disabled,
  onClick,
  size,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  size?: "default" | "icon" | "lg" | "sm";
}) => {
  return (
    <Button className={cn(className, "shadow-sm shadow-stone-400")} disabled={disabled} onClick={onClick} size={size}>
      {children}
      <ArrowRight className="h-3!" />
    </Button>
  );
};
