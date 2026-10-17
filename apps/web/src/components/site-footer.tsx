import { Link } from "@tanstack/react-router";

import { BrandMark } from "#/components/brand-mark";
import { Separator } from "#/components/ui/separator";

const GITHUB_URL = "https://github.com/zevium-dev/core";

const LINK_CLASS =
  "text-muted-foreground transition-colors duration-[var(--dur-instant)] ease-[var(--ease)] hover:text-foreground";

/** Public site footer: landing, docs and the legal/support pages. */
export function SiteFooter() {
  return (
    <footer>
      <Separator />
      <div className="flex w-full flex-col gap-5 px-4 py-8 sm:flex-row sm:items-center sm:justify-between md:px-6">
        <div className="flex min-w-0 flex-col gap-2">
          <Link
            to="/"
            aria-label="Zevium"
            className="flex items-center gap-0.5 self-start rounded-md text-sm font-semibold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <BrandMark className="h-3 w-4" />
            <span aria-hidden="true">evium</span>
          </Link>
          <p className="text-xs text-muted-foreground">
            Agent-first, per-call API marketplace.
          </p>
        </div>
        <nav
          aria-label="Footer navigation"
          className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm"
        >
          <Link to="/catalogue" className={LINK_CLASS}>
            Catalogue
          </Link>
          <Link to="/docs" className={LINK_CLASS}>
            Docs
          </Link>
          <Link to="/app/projects" className={LINK_CLASS}>
            Publish
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className={LINK_CLASS}
          >
            GitHub
          </a>
          <Link to="/support" className={LINK_CLASS}>
            Support
          </Link>
          <Link to="/privacy" className={LINK_CLASS}>
            Privacy
          </Link>
          <Link to="/terms" className={LINK_CLASS}>
            Terms
          </Link>
        </nav>
      </div>
    </footer>
  );
}
