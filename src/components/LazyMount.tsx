'use client';

import { useEffect, useRef, useState, ReactNode } from 'react';

interface LazyMountProps {
  /** Reserve this much vertical space until the children mount, so the
   *  IntersectionObserver fires correctly and the page doesn't jump. */
  minHeight?: number;
  /** Pre-mount when within this distance of the viewport. */
  rootMargin?: string;
  /** Force-mount once these dependencies change. Useful when a filter
   *  selection should immediately render even if the section is offscreen. */
  forceMountKey?: unknown;
  children: ReactNode;
}

/**
 * Renders a placeholder until it scrolls into view, then mounts children.
 * Lets us defer expensive components (RiskAdjustedReturns, SeriesStatsTable)
 * so they don't compute on every CSV load — only when the user looks at them.
 */
export default function LazyMount({
  minHeight = 480,
  rootMargin = '300px',
  forceMountKey,
  children,
}: LazyMountProps) {
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mounted) return;
    const el = ref.current;
    if (!el) return;

    if (typeof IntersectionObserver === 'undefined') {
      setMounted(true);
      return;
    }

    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setMounted(true);
          obs.disconnect();
        }
      },
      { rootMargin }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [mounted, rootMargin]);

  // Force mount when caller signals (e.g. user clicked something that
  // requires this component's data to be visible immediately).
  useEffect(() => {
    if (forceMountKey !== undefined && forceMountKey !== null && !mounted) {
      setMounted(true);
    }
  }, [forceMountKey, mounted]);

  return (
    <div ref={ref} style={mounted ? undefined : { minHeight }}>
      {mounted ? children : null}
    </div>
  );
}
