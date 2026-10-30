import React from 'react';

import { cn } from '@/lib/utils';

/**
 * The open file's path in its toolbar. While the whole path does not fit it
 * shows only the file name, which says more than the cut start of a path;
 * the full path stays in the tooltip.
 */
export function FilePathLabel({ path, className }: { path: string; className?: string }) {
  const boxRef = React.useRef<HTMLSpanElement | null>(null);
  const measureRef = React.useRef<HTMLSpanElement | null>(null);
  const [fits, setFits] = React.useState(true);
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;

  React.useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure) return;
    const update = () => setFits(measure.offsetWidth <= box.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, [path]);

  return (
    <span ref={boxRef} className={cn('relative min-w-0 flex-1 overflow-hidden', className)} title={path} dir="ltr">
      {/* The full path at its natural width, never shown: what it would need. */}
      <span ref={measureRef} aria-hidden className="invisible absolute whitespace-nowrap">{path}</span>
      <span className="block truncate">{fits ? path : name}</span>
    </span>
  );
}
