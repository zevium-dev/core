import { redirect, ToOptions, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Redirect: React.FC<{ to: ToOptions["to"] }> = ({ to }) => {
  const navigate = useNavigate();
  if (typeof window === "undefined") {
    throw redirect({ to });
  }
  useEffect(() => {
    void navigate({ to });
  }, [navigate, to]);
  return null;
};
