import { feature, pricedFeatureItem, product } from "atmn";

export const primaryFeature = feature({
  id: "primary-feature",
  name: "Primary Feature",
  type: "single_use",
});

export const credits = feature({
  credit_schema: [
    {
      credit_cost: 1,
      metered_feature_id: primaryFeature.id,
    },
  ],
  id: "primary-credit",
  name: "Credits",
  type: "credit_system",
});

export const primaryPlan = product({
  id: "primary-plan",
  items: [
    pricedFeatureItem({
      feature_id: credits.id,
      included_usage: 50,
      usage_model: "prepaid",
    }),
  ],
  name: "Primary Plan",
});

// Use `pnpm atmn push` to push the above definitions to Autumn.
