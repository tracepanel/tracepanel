// An app's mark: what runs it, or a plain app's when its SDK didn't say: never an empty tile. The map's boxes and the
// services table's rows alike.
import { RuntimeIcon, runtimeKind } from "@tracepanel/ui";
import { AppWindowIcon } from "lucide-react";

export function AppMark({ runtime }: { runtime: string | null | undefined }) {
  const kind = runtime ? runtimeKind(runtime) : null;
  return kind ? <RuntimeIcon kind={kind} /> : <AppWindowIcon className="size-3.5" aria-label="App" />;
}
