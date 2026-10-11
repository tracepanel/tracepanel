import type { ReactNode } from "react";
import type { Section } from "./routes";
import { NAV } from "./Sidebar";
import { PageHeader } from "./ui";

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
      <section className="grid flex-1 place-items-center px-10 pb-24" aria-label={title}>
        <div className="grid max-w-md justify-items-center gap-3 text-center">
          {Icon ? (
            <span className="mb-1 grid size-14 place-items-center rounded-2xl bg-brand-soft text-brand">
              <Icon className="size-7" />
            </span>
          ) : null}
          <h2 className="text-xl font-semibold">{empty}</h2>
          <p className="text-md text-muted-foreground">{children}</p>
        </div>
      </section>
    </main>
  );
}
