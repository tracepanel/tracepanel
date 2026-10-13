import { type DataSource, type ExplainPlan, snapshotFile, type Trace } from "@tracepanel/ui";
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
import { Share2Icon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

/** Slow queries whose plans go into a snapshot with values: EXPLAIN runs in the app, which the file can't reach. */
const MAX_PLANS = 5;

/** The plans of the trace's slow queries, as far as the app can explain them. */
async function plansOf(trace: Trace, source: DataSource): Promise<Record<string, ExplainPlan>> {
  const slow = trace.issues.filter((issue) => issue.kind === "slow-sql").flatMap((issue) => issue.span_ids);
  const plans: Record<string, ExplainPlan> = {};
  for (const span of [...new Set(slow)].slice(0, MAX_PLANS)) {
    try {
      plans[`${trace.id}/${span}`] = await source.explain(trace.id, span, false);
    } catch {
      // No plan for this one (the app is gone, the database refused): the snapshot goes without it.
    }
  }
  return plans;
}

/** A name for the file: the trace's name, made safe, and the end of its id. */
function fileName(trace: Trace): string {
  const name = trace.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `tracepanel-${name || "trace"}-${trace.id.slice(-6).toLowerCase()}.html`;
}

/** Make the snapshot file and hand it to the browser as a download. */
async function downloadSnapshot(trace: Trace, source: DataSource, values: boolean): Promise<void> {
  const snapshot = await source.snapshot?.(trace.id, values);
  if (!snapshot) throw new Error("This trace is no longer stored.");
  if (values) snapshot.plans = await plansOf(trace, source);
  const url = URL.createObjectURL(await snapshotFile(snapshot, `${trace.name} · Tracepanel snapshot`));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName(trace);
  link.click();
  // After the click has started the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ValuesOption({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2 text-sm">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} disabled={disabled} />
      <label htmlFor={id} className="grid gap-1 leading-snug">
        <span>Include values</span>
        <span className="text-muted-foreground">
          Query parameters, the plans of slow queries, email bodies, users' names and emails, log fields and the local
          variables of errors. Without them the file holds what Tracepanel Cloud would get.
        </span>
      </label>
    </div>
  );
}

/**
 * Share a trace as one HTML file: the console with the trace and what is linked to it, opening in any browser with
 * no agent and no network. Without values, what stays local on the way to the cloud stays local here too.
 */
function ShareDialog({
  trace,
  source,
  open,
  onOpenChange,
}: {
  trace: Trace;
  source: DataSource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [values, setValues] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues(false);
      setError(null);
    }
  }, [open]);

  const share = () => {
    setBusy(true);
    setError(null);
    downloadSnapshot(trace, source, values)
      .then(() => onOpenChange(false))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share this trace</DialogTitle>
          <DialogDescription>
            Download it as one HTML file, with the traces linked to it. The file opens in any browser, with no agent and
            no network, so you can send it to a teammate or attach it to an issue.
          </DialogDescription>
        </DialogHeader>
        <ValuesOption checked={values} onChange={setValues} disabled={busy} />
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={share} disabled={busy}>
            {busy ? "Preparing…" : "Download snapshot"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The Share button with its dialog. */
function ShareAction({ trace, source }: { trace: Trace; source: DataSource }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="mr-1 h-7 gap-1.5 px-2.5 text-sm shadow-none"
        onClick={() => setOpen(true)}
      >
        <Share2Icon aria-hidden="true" className="size-3.5" />
        Share
      </Button>
      <ShareDialog trace={trace} source={source} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** A trace's header actions, with Share first when the source makes snapshots. */
export function withShare(trace: Trace, source: DataSource, actions: ReactNode, shareable: boolean): ReactNode {
  if (!shareable || !source.snapshot) return actions;
  return (
    <>
      <ShareAction trace={trace} source={source} />
      {actions}
    </>
  );
}
