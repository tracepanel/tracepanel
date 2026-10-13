// 16px stroke icons (Lucide-style geometry), inherit currentColor.
import type { ReactNode } from "react";
import type { IssueKind } from "./types";

function Icon({ children, size = 16, label }: { children: ReactNode; size?: number; label?: string }) {
  return (
    <svg
      className="dt-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  );
}

export const LayersIcon = () => (
  <Icon>
    <path d="m12 2 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </Icon>
);
export const CopyIcon = () => (
  <Icon>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Icon>
);
export const ClockIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const AlertIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4M12 16h.01" />
  </Icon>
);
export const ChevronDownIcon = () => (
  <Icon size={14}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
export const ChevronRightIcon = () => (
  <Icon size={14}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);
export const ArrowLeftIcon = () => (
  <Icon>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </Icon>
);
export const ExternalIcon = () => (
  <Icon>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);
export const DockBottomIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 14h18" />
  </Icon>
);
export const DockRightIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M14 4v16" />
  </Icon>
);
export const DatabaseIcon = ({ size }: { size?: number }) => (
  <Icon size={size ?? 16}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);
/** Something swapped into the page (htmx). */
export const SwapIcon = () => (
  <Icon>
    <path d="M4 7h13l-3-3M20 17H7l3 3" />
  </Icon>
);
/** Clear, as in the browser's Network tab. */
export const ClearIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="m5.6 5.6 12.8 12.8" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon>
    <path d="m5 12 5 5L20 7" />
  </Icon>
);

const ISSUE_ICONS: Partial<Record<IssueKind, () => React.JSX.Element>> = {
  "n+1": LayersIcon,
  duplicates: CopyIcon,
  "slow-sql": ClockIcon,
  "slow-http": ClockIcon,
  "long-transaction": ClockIcon,
  htmx: SwapIcon,
  "queue-wait": ClockIcon,
  "blocking-call": ClockIcon,
  "large-result": LayersIcon,
};

export function IssueIcon({ kind }: { kind: IssueKind }) {
  const KindIcon = ISSUE_ICONS[kind] ?? AlertIcon;
  return <KindIcon />;
}
