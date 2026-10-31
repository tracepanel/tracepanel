import { type RuntimeKind, runtimeMark, runtimeName } from "@tracepanel/ui/lib/runtime";
import { cn } from "@tracepanel/ui/lib/utils";
import { GlobeIcon } from "lucide-react";
import { useId } from "react";

/**
 * What runs an app: its owner's logo, unaltered, where the owner's policy allows it; the globe for a page in the
 * browser; else our monogram of its name, in the theme's icon colour. The page widget's pill draws the same choice.
 */
export function RuntimeIcon({ kind, className }: { kind: RuntimeKind; className?: string }) {
  // A gradient's id is the page's, and one per icon: two of the same logo in a list each keep their own.
  const id = `dt-logo-${useId().replace(/[^\w-]/g, "")}`;
  const name = runtimeName(kind);
  const mark = runtimeMark(kind);
  if (mark.type === "browser") {
    return <GlobeIcon className={cn("dt-icon size-3.5", className)} role="img" aria-label={name} />;
  }
  if (mark.type === "monogram") {
    // Its letters are drawn by CSS (.dt-monogram), not text in the page: a chip's or a row's text stays its name.
    return (
      <span
        className={cn("dt-icon dt-monogram size-3.5", className)}
        role="img"
        aria-label={name}
        title={name}
        data-mark="monogram"
        data-letters={mark.letters}
      />
    );
  }
  const { logo } = mark;
  return (
    <svg
      className={cn("dt-icon", className)}
      viewBox={logo.viewBox}
      width={14}
      height={14}
      role="img"
      aria-label={name}
      data-mark="logo"
    >
      <defs>
        <radialGradient
          id={id}
          cx={logo.gradient.cx}
          cy={logo.gradient.cy}
          r={logo.gradient.r}
          gradientUnits="userSpaceOnUse"
        >
          {logo.gradient.stops.map(([offset, color]) => (
            <stop key={offset} offset={offset} stopColor={color} />
          ))}
        </radialGradient>
      </defs>
      <path d={logo.path} fill={`url(#${id})`} />
    </svg>
  );
}
