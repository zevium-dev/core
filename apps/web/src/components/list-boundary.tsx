import { Component, type ReactNode } from "react";
import { Button } from "#/components/ui/button";
import { humanError } from "#/lib/human-error";

type Props = { children: ReactNode; label: string };

/** Paginated Convex hooks throw query errors; keep them inside their list. */
export function ListBoundary({
  resetKey = "",
  ...props
}: Props & { resetKey?: string }) {
  return <Boundary key={resetKey} {...props} />;
}

class Boundary extends Component<Props, { failed: boolean; error: unknown }> {
  state = { failed: false, error: undefined as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-md border p-4"
      >
        <p className="text-sm font-medium">Could not load {this.props.label}</p>
        <p className="text-sm text-muted-foreground">
          {humanError(this.state.error, "Check your connection, then retry.")}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => this.setState({ failed: false, error: undefined })}
        >
          Retry
        </Button>
      </div>
    );
  }
}
