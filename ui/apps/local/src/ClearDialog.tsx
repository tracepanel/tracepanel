import type { DataSource } from "@tracepanel/ui";
import { Button } from "@tracepanel/ui/components/ui/button";
import { Checkbox } from "@tracepanel/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@tracepanel/ui/components/ui/dialog";
import { useEffect, useId, useState } from "react";

/**
 * Clearing, with permanent deletion behind a checkbox.
 *
 * In the panel it clears the browser tab's request list (the store keeps them), and the checkbox also deletes the
 * store. In the console deleting the store is the only action, so the checkbox confirms it. Without
 * `source.clearStore` (a source that can't clear its store) there is no checkbox: the panel only clears its list.
 */
export function ClearDialog({
  mode,
  open,
  onOpenChange,
  source,
  onCleared,
}: {
  mode: "panel" | "console";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: DataSource;
  /** After clearing; `permanent` when the store was deleted too. */
  onCleared: (permanent: boolean) => void;
}) {
  const [checked, setChecked] = useState(false);
  const [traces, setTraces] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deletable = source.clearStore !== undefined;
  const checkboxId = useId();

  useEffect(() => {
    if (!open) return;
    setChecked(false);
    setError(null);
    setTraces(null);
    let cancelled = false;
    source.counts().then(
      // The traces per entry point; `calls` says whether any made HTTP calls, it counts no traces.
      (counts) =>
        !cancelled &&
        setTraces(
          Object.values(counts.sections).reduce<number>(
            (sum, count) => sum + (typeof count === "number" ? count : 0),
            0,
          ),
        ),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [open, source]);

  const stored =
    traces === null ? "every stored trace" : `${traces.toLocaleString()} stored ${traces === 1 ? "trace" : "traces"}`;
  const permanent = mode === "console" || checked;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (permanent) await source.clearStore?.();
      onOpenChange(false);
      onCleared(permanent);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "panel" ? "Clear requests" : "Delete all data"}</DialogTitle>
          <DialogDescription>
            {mode === "panel"
              ? "Starts this browser tab's list over from the current page. The requests stay in the console."
              : `Deletes ${stored} with their logs, queries, emails and issues from .tracepanel/.`}
          </DialogDescription>
        </DialogHeader>
        {deletable ? (
          <label
            htmlFor={checkboxId}
            className="flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 text-base has-[[data-state=checked]]:border-error/40 has-[[data-state=checked]]:bg-error/5"
          >
            <Checkbox
              id={checkboxId}
              className="mt-0.5"
              checked={checked}
              onCheckedChange={(value) => setChecked(value === true)}
              disabled={busy}
            />
            <span className="grid gap-1">
              <span className="font-medium">
                {mode === "panel" ? "Also delete all stored data permanently" : "Delete permanently"}
              </span>
              <span className="text-muted-foreground">
                {mode === "panel"
                  ? `${stored[0]?.toUpperCase()}${stored.slice(1)}, with logs, queries, emails and issues. `
                  : ""}
                This can't be undone.
              </span>
            </span>
          </label>
        ) : null}
        {error ? <p className="text-base text-error">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={permanent ? "destructive" : "default"}
            onClick={confirm}
            disabled={busy || (mode === "console" && !checked)}
          >
            {permanent ? "Delete" : "Clear"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
