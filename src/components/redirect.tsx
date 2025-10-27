import { redirect, ToOptions, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Redirect: React.FC<{ params?: ToOptions["params"]; to: ToOptions["to"] }> = ({ params, to }) => {
  const navigate = useNavigate();
  if (typeof window === "undefined") {
    throw redirect({ to });
  }
  useEffect(() => {
    void navigate({ params, to });
  }, [navigate, params, to]);
  return null;
};
