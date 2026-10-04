import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type FallbackRenderArgs = {
  error: Error;
  reset: () => void;
};

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode | ((args: FallbackRenderArgs) => ReactNode);
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onReset?: () => void;
  resetKeys?: readonly unknown[];
  title?: string;
  description?: string;
};

type ErrorBoundaryState = {
  error: Error | null;
};

function haveResetKeysChanged(
  prevResetKeys: readonly unknown[] | undefined,
  nextResetKeys: readonly unknown[] | undefined,
) {
  if (prevResetKeys === nextResetKeys) return false;
  if (!prevResetKeys || !nextResetKeys) return true;
  if (prevResetKeys.length !== nextResetKeys.length) return true;
  return prevResetKeys.some((key, index) => !Object.is(key, nextResetKeys[index]));
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.props.onError?.(error, errorInfo);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && haveResetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  reset = () => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    const { fallback, title, description } = this.props;

    if (typeof fallback === "function") {
      return fallback({ error, reset: this.reset });
    }

    if (fallback) {
      return fallback;
    }

    return (
      <Card className="border-amber-300 bg-amber-50/70 dark:bg-amber-950/30">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400" />
              {title ?? "Something went wrong"}
            </CardTitle>
            <CardDescription>
              {description ??
                "This section hit an unexpected error. Try again, or refresh the page if it keeps happening."}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <div className="rounded-lg border border-amber-200/80 bg-background/70 px-3 py-2 text-xs text-muted-foreground dark:border-amber-900/70 dark:bg-background/40">
            {error.message || "Unknown error"}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={this.reset}>
              <RotateCcw className="h-3.5 w-3.5" />
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
              Refresh page
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
}
