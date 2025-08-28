import { Link } from "@tanstack/react-router";

export function Footer() {
  return (
    <footer className="border-t">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <img alt="" className="size-5" src="/logo.svg" />
            <span>© {new Date().getFullYear()} Zevium</span>
          </div>
          <nav className="text-muted-foreground flex items-center gap-5 text-sm">
            <Link className="hover:text-foreground transition-colors" to="/">
              Docs
            </Link>
            <Link className="hover:text-foreground transition-colors" to="/">
              Pricing
            </Link>
            <Link className="hover:text-foreground transition-colors" to="/">
              Contact
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
