"use client";

import { useEffect, type RefObject } from "react";

/**
 * Trap Tab focus inside `containerRef` while `active`. Restores focus to
 * the previously focused element on deactivate.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!active) return;
    const root = containerRef.current;
    if (!root) return;

    const prev = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);

    const list = focusables();
    (list[0] ?? root).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const cur = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (cur === first || !root.contains(cur)) {
          e.preventDefault();
          last.focus();
        }
      } else if (cur === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [active, containerRef]);
}

/** True when the user prefers reduced motion (SSR-safe snapshot). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
