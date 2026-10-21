import { type App, AppDetails, type DataSource, RuntimeIcon, runtimeKind, type ServiceApp } from "@tracepanel/ui";
import { useEffect, useState } from "react";
import { href } from "./routes";
import { sectionLabel } from "./sections";
import { appTarget, roleSection } from "./services";
import { Breadcrumbs, Loading, Mono } from "./ui";

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

/** Where the app's own work is listed: its requests, tasks, jobs or pages, a link for each role it runs as. */
function RoleLinks({ roles }: { roles: readonly ServiceApp[] }) {
  if (!roles.length) return null;
  return (
    <nav aria-label="Its work" className="flex flex-wrap gap-x-4 gap-y-1 text-md">
      {roles.map((role) => (
        <a key={role.role} href={href(appTarget(role))} className="text-brand hover:underline">
          {roleLabel(role)}
          <span className="ml-1.5 text-muted-foreground tabular-nums">{role.traces.toLocaleString()}</span>
        </a>
      ))}
    </nav>
  );
}

/** The app's name with its runtime's mark, and what runs it under. */
function Title({ service, runtime }: { service: string; runtime: string | null }) {
  const kind = runtime ? runtimeKind(runtime) : null;
  return (
    <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight [&_svg]:size-6">
      {kind ? <RuntimeIcon kind={kind} /> : null}
      {service}
    </h1>
  );
}

function AppHeader({ service, roles }: { service: string; roles: readonly ServiceApp[] }) {
  const runtime = roles.find((role) => role.runtime)?.runtime ?? null;
  return (
    <header className="grid gap-3">
      <Breadcrumbs items={[{ label: "Services", href: href({ name: "services", q: "" }) }, { label: service }]} />
      <Title service={service} runtime={runtime} />
      {runtime ? <Mono className="text-sm text-muted-foreground">{runtime}</Mono> : null}
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
    <div className="grid min-w-0 max-w-5xl grid-cols-[minmax(0,1fr)] gap-7 px-10 pt-7 pb-16 *:min-w-0">
      <AppHeader service={service} roles={roles} />
      <AppDetails app={app} />
    </div>
  );
}
