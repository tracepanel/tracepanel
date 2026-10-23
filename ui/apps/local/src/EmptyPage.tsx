import { Empty } from "@tracepanel/ui";
import type { ReactNode } from "react";
import type { Section } from "./routes";
import { NAV } from "./Sidebar";
import { Loading, PageHeader } from "./ui";

/**
 * A section with nothing stored yet: its title and what will show up, without the search, filters and refresh that
 * have nothing to work on. The page's data keeps loading behind it, so the first call replaces it.
 */
export function EmptyPage({
  section,
  title,
  description,
  empty,
  children,
}: {
  section: Section;
  title: string;
  description: string;
  /** What isn't there yet: "No HTTP traffic yet". */
  empty: string;
  children: ReactNode;
}) {
  const Icon = NAV.find((item) => item.section === section)?.icon;
  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-background">
      <PageHeader title={title} description={description} />
      <section className="grid flex-1 place-items-center px-10" aria-label={title}>
        <Empty title={empty} icon={Icon} page={true}>
          {children}
        </Empty>
      </section>
    </main>
  );
}

/**
 * A section before its first answer, when it may yet turn out empty: its title only, under a loading bar. Then the
 * page or its empty state, whichever it is, without showing a search and filters an empty one would take away.
 */
export function PageShell({ title, description }: { title: string; description: string }) {
  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-background">
      <PageHeader title={title} description={description} />
      <div className="px-10 pt-5" aria-busy>
        <Loading />
      </div>
    </main>
  );
}
