import type { Product, ProductItem } from "autumn-js";

import { ProductDetails, useCustomer, usePricingTable } from "autumn-js/react";
import { Loader2 } from "lucide-react";
import React from "react";
import { createContext, use, useState } from "react";

import CheckoutDialog from "~/components/autumn/checkout-dialog";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { getPricingTableContent } from "~/lib/autumn/pricing-table-content";
import { cn } from "~/lib/utils/index";

export default function PricingTable({ productDetails }: { productDetails?: Array<ProductDetails> }) {
  const { checkout, customer } = useCustomer({ errorOnNotFound: false });

  const [isAnnual, setIsAnnual] = useState(false);
  const { error, isLoading, products } = usePricingTable({ productDetails });

  if (isLoading) {
    return (
      <div className="flex h-full min-h-[300px] w-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (error) {
    return <div> Something went wrong...</div>;
  }

  const intervals = Array.from(new Set(products?.map((p) => p.properties?.interval_group).filter((i) => !!i)));

  const multiInterval = intervals.length > 1;

  const intervalFilter = (product: Product) => {
    if (!product.properties?.interval_group) {
      return true;
    }

    if (multiInterval) {
      if (isAnnual) {
        return product.properties?.interval_group === "year";
      } else {
        return product.properties?.interval_group === "month";
      }
    }

    return true;
  };

  return (
    <div className={cn("root")}>
      {products && (
        <PricingTableContainer
          isAnnualToggle={isAnnual}
          multiInterval={multiInterval}
          products={products}
          setIsAnnualToggle={setIsAnnual}
        >
          {products.filter(intervalFilter).map((product, index) => (
            <PricingCard
              buttonProps={{
                disabled:
                  (product.scenario === "active" && !product.properties.updateable) || product.scenario === "scheduled",

                onClick: async () => {
                  if (product.id && customer) {
                    await checkout({
                      dialog: CheckoutDialog,
                      productId: product.id,
                    });
                  } else if (product.display?.button_url) {
                    window.open(product.display?.button_url, "_blank");
                  }
                },
              }}
              key={index}
              productId={product.id}
            />
          ))}
        </PricingTableContainer>
      )}
    </div>
  );
}

const PricingTableContext = createContext<{
  isAnnualToggle: boolean;
  products: Array<Product>;
  setIsAnnualToggle: (isAnnual: boolean) => void;
  showFeatures: boolean;
}>({
  isAnnualToggle: false,
  products: [],
  setIsAnnualToggle: () => void 0,
  showFeatures: true,
});

export const usePricingTableContext = (componentName: string) => {
  const context = use(PricingTableContext);

  if (context === undefined) {
    throw new Error(`${componentName} must be used within <PricingTable />`);
  }

  return context;
};

export const PricingTableContainer = ({
  children,
  className,
  isAnnualToggle,
  multiInterval,
  products,
  setIsAnnualToggle,
  showFeatures = true,
}: {
  children?: React.ReactNode;
  className?: string;
  isAnnualToggle: boolean;
  multiInterval: boolean;
  products?: Array<Product>;
  setIsAnnualToggle: (isAnnual: boolean) => void;
  showFeatures?: boolean;
}) => {
  if (!products) {
    throw new Error("products is required in <PricingTable />");
  }

  if (products.length === 0) {
    return <></>;
  }

  const hasRecommended = products?.some((p) => p.display?.recommend_text);
  return (
    <PricingTableContext.Provider value={{ isAnnualToggle, products, setIsAnnualToggle, showFeatures }}>
      <div className={cn("flex flex-col items-center", hasRecommended && "!py-10")}>
        {multiInterval && (
          <div className={cn(products.some((p) => p.display?.recommend_text) && "mb-8")}>
            <AnnualSwitch isAnnualToggle={isAnnualToggle} setIsAnnualToggle={setIsAnnualToggle} />
          </div>
        )}
        <div
          className={cn(
            "grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]",
            className,
          )}
        >
          {children}
        </div>
      </div>
    </PricingTableContext.Provider>
  );
};

interface PricingCardProps {
  buttonProps?: React.ComponentProps<"button">;
  className?: string;
  onButtonClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  productId: string;
  showFeatures?: boolean;
}

export const PricingCard = ({ buttonProps, className, productId }: PricingCardProps) => {
  const { products, showFeatures } = usePricingTableContext("PricingCard");

  const product = products.find((p) => p.id === productId);

  if (!product) {
    throw new Error(`Product with id ${productId} not found`);
  }

  const { display: productDisplay, name } = product;

  const { buttonText } = getPricingTableContent(product);

  const isRecommended = productDisplay?.recommend_text ? true : false;
  const mainPriceDisplay = product.properties?.is_free
    ? {
        primary_text: "Free",
      }
    : product.items[0].display;

  const featureItems = product.properties?.is_free ? product.items : product.items.slice(1);

  return (
    <div
      className={cn(
        "text-foreground h-full w-full max-w-xl rounded-lg border py-6 shadow-sm",
        isRecommended &&
          "bg-secondary/40 lg:h-[calc(100%+48px)] lg:-translate-y-6 lg:shadow-lg dark:shadow-zinc-800/80",
        className,
      )}
    >
      {productDisplay?.recommend_text && <RecommendedBadge recommended={productDisplay?.recommend_text} />}
      <div className={cn("flex h-full flex-grow flex-col", isRecommended && "lg:translate-y-6")}>
        <div className="h-full">
          <div className="flex flex-col">
            <div className="pb-4">
              <h2 className="truncate px-6 text-2xl font-semibold">{productDisplay?.name || name}</h2>
              {productDisplay?.description && (
                <div className="text-muted-foreground h-8 px-6 text-sm">
                  <p className="line-clamp-2">{productDisplay?.description}</p>
                </div>
              )}
            </div>
            <div className="mb-2">
              <h3 className="bg-secondary/40 mb-4 flex h-16 items-center border-y px-6 font-semibold">
                <div className="line-clamp-2">
                  {mainPriceDisplay?.primary_text}{" "}
                  {mainPriceDisplay?.secondary_text && (
                    <span className="text-muted-foreground mt-1 font-normal">{mainPriceDisplay?.secondary_text}</span>
                  )}
                </div>
              </h3>
            </div>
          </div>
          {showFeatures && featureItems.length > 0 && (
            <div className="mb-6 flex-grow px-6">
              <PricingFeatureList everythingFrom={product.display?.everything_from} items={featureItems} />
            </div>
          )}
        </div>
        <div className={cn("px-6", isRecommended && "lg:-translate-y-12")}>
          <PricingCardButton recommended={productDisplay?.recommend_text ? true : false} {...buttonProps}>
            {productDisplay?.button_text || buttonText}
          </PricingCardButton>
        </div>
      </div>
    </div>
  );
};

// Pricing Feature List
export const PricingFeatureList = ({
  className,
  everythingFrom,
  items,
}: {
  className?: string;
  everythingFrom?: string;
  items: Array<ProductItem>;
}) => {
  return (
    <div className={cn("flex-grow", className)}>
      {everythingFrom && <p className="mb-4 text-sm">Everything from {everythingFrom}, plus:</p>}
      <div className="space-y-3">
        {items.map((item, index) => (
          <div className="flex items-start gap-2 text-sm" key={index}>
            {/* {showIcon && (
              <Check className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
            )} */}
            <div className="flex flex-col">
              <span>{item.display?.primary_text}</span>
              {item.display?.secondary_text && (
                <span className="text-muted-foreground text-sm">{item.display?.secondary_text}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// Pricing Card Button
export interface PricingCardButtonProps extends React.ComponentProps<"button"> {
  buttonUrl?: string;
  recommended?: boolean;
}

export const PricingCardButton = ({
  children,
  className,
  onClick,
  recommended,
  ref,
  ...props
}: PricingCardButtonProps) => {
  const [loading, setLoading] = useState(false);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    setLoading(true);
    try {
      onClick?.(e);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      className={cn(
        "group relative w-full overflow-hidden rounded-lg border px-4 py-3 transition-all duration-300 hover:brightness-90",
        className,
      )}
      {...props}
      disabled={loading || props.disabled}
      onClick={handleClick}
      ref={ref}
      variant={recommended ? "default" : "secondary"}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <>
          <div className="flex w-full items-center justify-between transition-transform duration-300 group-hover:translate-y-[-130%]">
            <span>{children}</span>
            <span className="text-sm">→</span>
          </div>
          <div className="absolute mt-2 flex w-full translate-y-[130%] items-center justify-between px-4 transition-transform duration-300 group-hover:mt-0 group-hover:translate-y-0">
            <span>{children}</span>
            <span className="text-sm">→</span>
          </div>
        </>
      )}
    </Button>
  );
};
PricingCardButton.displayName = "PricingCardButton";

// Annual Switch
export const AnnualSwitch = ({
  isAnnualToggle,
  setIsAnnualToggle,
}: {
  isAnnualToggle: boolean;
  setIsAnnualToggle: (isAnnual: boolean) => void;
}) => {
  return (
    <div className="mb-4 flex items-center space-x-2">
      <span className="text-muted-foreground text-sm">Monthly</span>
      <Switch checked={isAnnualToggle} id="annual-billing" onCheckedChange={setIsAnnualToggle} />
      <span className="text-muted-foreground text-sm">Annual</span>
    </div>
  );
};

export const RecommendedBadge = ({ recommended }: { recommended: string }) => {
  return (
    <div className="bg-secondary text-muted-foreground absolute top-[-1px] right-[-1px] rounded-bl-lg border px-3 text-sm font-medium lg:top-4 lg:right-4 lg:rounded-full lg:py-0.5">
      {recommended}
    </div>
  );
};
