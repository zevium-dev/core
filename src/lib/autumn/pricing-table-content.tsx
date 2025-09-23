import { type Product } from "autumn-js";

export const getPricingTableContent = (product: Product) => {
  const { properties, scenario } = product;
  const { has_trial, is_one_off, updateable } = properties;

  if (has_trial) {
    return {
      buttonText: <p>Start Free Trial</p>,
    };
  }

  switch (scenario) {
    case "active":
      if (updateable) {
        return {
          buttonText: <p>Update Plan</p>,
        };
      }

      return {
        buttonText: <p>Current Plan</p>,
      };

    case "cancel":
      return {
        buttonText: <p>Cancel Plan</p>,
      };

    case "downgrade":
      return {
        buttonText: <p>Downgrade</p>,
      };

    case "new":
      if (is_one_off) {
        return {
          buttonText: <p>Purchase</p>,
        };
      }

      return {
        buttonText: <p>Get started</p>,
      };

    case "renew":
      return {
        buttonText: <p>Renew</p>,
      };

    case "scheduled":
      return {
        buttonText: <p>Plan Scheduled</p>,
      };

    case "upgrade":
      return {
        buttonText: <p>Upgrade</p>,
      };

    default:
      return {
        buttonText: <p>Get Started</p>,
      };
  }
};
