import { Link } from "@tanstack/react-router";
import React from "react";

export const NotFound: React.FC<React.PropsWithChildren> = ({ children }) => {
  return (
    <div className="space-y-2 p-2">
      <div className="text-muted-foreground">{children ?? <p>The page you are looking for does not exist.</p>}</div>
      <p className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-sm bg-secondary px-2 py-1 text-sm font-black text-secondary-foreground uppercase"
          onClick={() => window.history.back()}
          type="button"
        >
          Go back
        </button>
        <Link className="rounded-sm bg-primary px-2 py-1 text-sm font-black text-primary-foreground uppercase" to="/">
          Start Over
        </Link>
      </p>
    </div>
  );
};
