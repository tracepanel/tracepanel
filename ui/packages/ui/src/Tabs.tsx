import type { ReactNode } from "react";

export interface Tab<T extends string> {
  id: T;
  label: string;
  count?: number | undefined;
  tone?: "warn" | "error" | undefined;
  /** A muted note after the count: the time the SQL tab's queries took. */
  detail?: string | undefined;
  /** Shown after the label instead of a count: the request's status, a task's outcome. */
  badge?: ReactNode;
  /** A small icon before the label. */
  icon?: ReactNode;
}

export interface TabsProps<T extends string> {
  tabs: readonly Tab<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}

export function Tabs<T extends string>({ tabs, active, onChange, label }: TabsProps<T>) {
  return (
    <div className="dt-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className="dt-tab"
          // Narrow, the other tabs show their icon and count only: the name is in the tooltip.
          title={tab.label}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon ?? null}
          <span className="dt-tab-label">{tab.label}</span>
          {tab.count === undefined ? null : (
            <span className="dt-tab-count" data-tone={tab.tone}>
              {tab.count}
            </span>
          )}
          {tab.badge ?? null}
          {tab.detail ? <span className="dt-tab-detail">{tab.detail}</span> : null}
        </button>
      ))}
    </div>
  );
}
