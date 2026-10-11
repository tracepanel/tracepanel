import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names; later Tailwind utilities win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** `value` rem in CSS pixels at the page's root font size: sizes set in code follow the density as the CSS does. */
export function rem(value: number): number {
  const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return value * (root || 16);
}
