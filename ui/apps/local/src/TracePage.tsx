import type { DataSource, TabId } from "@tracepanel/ui";
import { exploreFor } from "./explore";
import { go, openTrace, parse } from "./routes";
import { crumbsFor } from "./sections";
import { TraceScreen } from "./TraceScreen";
import { Breadcrumbs, Mono } from "./ui";

const TABS: TabId[] = ["request", "tree", "issues", "sql", "logs", "mail", "error"];

/**
 * A trace, the same page wherever it was opened from: the crumbs lead back there (`from`), the open tab is in the
 * URL (a link to its call tree stays a link to its call tree), Explore leads to its group, issues and nearby logs.
 */
export function TracePage({
  id,
  from,
  tab,
  source,
}: {
  id: string;
  from?: string | undefined;
  tab?: string | undefined;
  source: DataSource;
}) {
  const back = from ? crumbsFor(parse(from), from) : [];
  const initialTab = TABS.find((item) => item === tab);
  return (
    <main className="min-h-0 min-w-0 overflow-y-auto bg-background">
      {/* The trace's own header is inset 16px: the page pads 16px less so the crumbs line up with it. */}
      <div className="w-full px-6 pt-5 pb-12">
        {/* A stored trace never changes: no refresh control here. */}
        <div className="px-4">
          <Breadcrumbs
            items={[
              ...back,
              {
                label: (
                  <>
                    Trace <Mono className="text-[14px] font-normal">{id}</Mono>
                  </>
                ),
              },
            ]}
          />
        </div>
        <TraceScreen
          key={id}
          id={id}
          source={source}
          initialTab={initialTab}
          onTabChange={(next) => go({ name: "trace", id, from, tab: next }, true)}
          explore={(trace) => exploreFor(trace, go)}
          onOpenTrace={(linked) => openTrace(linked)}
        />
      </div>
    </main>
  );
}
