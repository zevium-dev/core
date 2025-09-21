import { type CheckoutResult } from "autumn-js";

export const getCheckoutContent = (checkoutResult: CheckoutResult) => {
  const { current_product, next_cycle, product } = checkoutResult;
  const { has_trial, is_free, is_one_off, updateable } = product.properties;
  const scenario = product.scenario;

  const nextCycleAtStr = next_cycle ? new Date(next_cycle.starts_at).toLocaleDateString() : undefined;

  const productName = product.name;

  if (is_one_off) {
    return {
      message: <p>By clicking confirm, you will purchase {productName} and your card will be charged immediately.</p>,
      title: <p>Purchase {productName}</p>,
    };
  }

  if (scenario == "active" && updateable) {
    if (updateable) {
      return {
        message: (
          <p>
            Update your prepaid quantity. You&apos;ll be charged or credited the prorated difference based on your
            current billing cycle.
          </p>
        ),
        title: <p>Update Plan</p>,
      };
    }
  }

  if (has_trial) {
    return {
      message: (
        <p>
          By clicking confirm, you will start a free trial of {productName} which ends on {nextCycleAtStr}.
        </p>
      ),
      title: <p>Start trial for {productName}</p>,
    };
  }

  switch (scenario) {
    case "active":
      return {
        message: <p>You are already subscribed to this product.</p>,
        title: <p>Product already active</p>,
      };

    case "cancel":
      return {
        message: (
          <p>
            By clicking confirm, your subscription to {current_product.name} will end on {nextCycleAtStr}.
          </p>
        ),
        title: <p>Cancel</p>,
      };

    case "downgrade":
      return {
        message: (
          <p>
            By clicking confirm, your current subscription to {current_product.name} will be cancelled and a new
            subscription to {productName} will begin on {nextCycleAtStr}.
          </p>
        ),
        title: <p>Downgrade to {productName}</p>,
      };
    case "new":
      if (is_free) {
        return {
          message: <p>By clicking confirm, {productName} will be enabled immediately.</p>,
          title: <p>Enable {productName}</p>,
        };
      }

      return {
        message: (
          <p>By clicking confirm, you will be subscribed to {productName} and your card will be charged immediately.</p>
        ),
        title: <p>Subscribe to {productName}</p>,
      };

    case "renew":
      return {
        message: <p>By clicking confirm, you will renew your subscription to {productName}.</p>,
        title: <p>Renew</p>,
      };

    case "scheduled":
      return {
        message: (
          <p>
            You are currently on product {current_product.name} and are scheduled to start {productName} on{" "}
            {nextCycleAtStr}.
          </p>
        ),
        title: <p>{productName} product already scheduled</p>,
      };

    case "upgrade":
      return {
        message: (
          <p>
            By clicking confirm, you will upgrade to {productName} and your payment method will be charged immediately.
          </p>
        ),
        title: <p>Upgrade to {productName}</p>,
      };

    default:
      return {
        message: <p>You are about to change your subscription.</p>,
        title: <p>Change Subscription</p>,
      };
  }
};
