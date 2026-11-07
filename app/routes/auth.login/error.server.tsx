import type { LoginError } from "@shopify/shopify-app-react-router/server";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

interface LoginErrorMessage {
  shop?: string;
}

export function loginErrorMessage(loginErrors: LoginError): LoginErrorMessage {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "Enter your store domain to continue." };
  } else if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return {
      shop: "That is not a Shopify store domain. It should end in .myshopify.com.",
    };
  }

  return {};
}
