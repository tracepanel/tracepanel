import { type App, AppDetails, AppMark, type DataSource, type ServiceApp, serviceRuntime } from "@tracepanel/ui";
import { ActivityIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { consoleLinks, href } from "./routes";
import { NAV } from "./Sidebar";
import { sectionLabel } from "./sections";
import { appTarget, roleSection } from "./services";
import { CrumbBar, Loading } from "./ui";

/** What the app said about itself (null when nothing, or an agent from before), and its roles on the service map. */
function useAppPage(service: string, source: DataSource) {
  const [app, setApp] = useState<App | null | undefined>(undefined);
  const [roles, setRoles] = useState<ServiceApp[]>([]);
  useEffect(() => {
    let cancelled = false;
    const asked = source.app ? source.app(service) : Promise.resolve(null);
    asked.then(
      (result) => !cancelled && setApp(result),
      () => !cancelled && setApp(null),
    );
    source.listServices("").then(
      (map) => !cancelled && setRoles(map.apps.filter((each) => each.service === service)),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [service, source]);
  return { app, roles };
}

/** The section's name; "Traces" where the role has no section of its own (every trace of the app). */
function roleLabel(role: ServiceApp): string {
  const section = roleSection(role);
  return section === "traces" ? "Traces" : sectionLabel(section);
}

/** The role's section mark, as the menu shows it; a trace's mark where the role has no section of its own. */
function roleIcon(role: ServiceApp): LucideIcon {
  const section = roleSection(role);
  return NAV.find((item) => item.section === section)?.icon ?? ActivityIcon;
}

/** Where the app's own work is listed: its requests, tasks, jobs or pages, a link for each role it runs as. */
function RoleLinks({ roles }: { roles: readonly ServiceApp[] }) {
  if (!roles.length) return null;
  return (
    <nav aria-label="Its work" className="flex flex-wrap gap-2">
      {roles.map((role) => {
        const Icon = roleIcon(role);
        return (
          <a
            key={role.role}
            href={href(appTarget(role))}
            className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium">{roleLabel(role)}</span>
            <span className="text-muted-foreground tabular-nums">{role.traces.toLocaleString()}</span>
          </a>
        );
      })}
    </nav>
  );
}

/** The app's name with its runtime's mark, and what runs it under. */
function Title({ service, runtime }: { service: string; runtime: string | null }) {
  return (
    <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight [&_svg]:size-6 [&_.dt-monogram]:size-6">
      <AppMark runtime={runtime} />
      {service}
    </h1>
  );
}

function AppHeader({ service, roles }: { service: string; roles: readonly ServiceApp[] }) {
  const runtime = serviceRuntime(roles.map((role) => role.runtime));
  return (
    <header className="grid gap-3">
      <CrumbBar items={[{ label: "Services", href: href({ name: "services", q: "" }) }, { label: service }]} />
      <Title service={service} runtime={runtime} />
      {runtime ? <p className="text-sm text-muted-foreground">{runtime}</p> : null}
      <RoleLinks roles={roles} />
    </header>
  );
}

/**
 * One app of the project, as the Services page's row opens it: what runs it, where its work is, and its settings and
 * versions as it said them (the panel's App tab shows the same).
 */
export function AppPage({ service, source }: { service: string; source: DataSource }) {
  const { app, roles } = useAppPage(service, source);
  if (app === undefined) return <Loading />;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-7 px-10 pt-7 pb-16 *:min-w-0">
      <AppHeader service={service} roles={roles} />
      <AppDetails app={app} links={consoleLinks()} />
    </div>
  );
}
