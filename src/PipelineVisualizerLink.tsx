// The single "Open in Pipeline Visualizer" control. When the separate
// Visualizer app is known to be installed it is a plain link (as before);
// otherwise it opens a short notice explaining the app is missing, instead of
// sending the user to Cribl's "insufficient permissions" page. When the probe
// could not tell (always, today), the notice also offers the link itself.
import { useEffect, useState, type ReactNode } from 'react';
import {
  cachedVisualizerAvailability, probePipelineVisualizer, visualizerControl,
  type VisualizerAvailability,
} from './pipeline-visualizer-link';

export function useVisualizerAvailability(): VisualizerAvailability | null {
  const [availability, setAvailability] = useState<VisualizerAvailability | null>(cachedVisualizerAvailability);
  useEffect(() => {
    if (availability) return;
    let live = true;
    void probePipelineVisualizer().then((r) => { if (live) setAvailability(r); });
    return () => { live = false; };
  }, [availability]);
  return availability;
}

export function PipelineVisualizerLink({ href, className, title, children, align = 'right', availability: forced }: {
  href: string;
  className: string;
  title: string;
  children: ReactNode;
  /** Which edge of the control the notice lines up with. */
  align?: 'left' | 'right';
  /** Tests only: skip the probe. */
  availability?: VisualizerAvailability | null;
}) {
  const probed = useVisualizerAvailability();
  const control = visualizerControl(forced !== undefined ? forced : probed);
  const [open, setOpen] = useState(false);
  if (control.kind === 'link') {
    return <a className={className} href={href} target="_blank" rel="noopener noreferrer" title={title}>{children}</a>;
  }
  return (
    <span className="pv-wrap">
      <button type="button" className={`${className} pv-unavailable`} aria-expanded={open}
        title="Pipeline Visualizer is a separate app — click for details" onClick={() => setOpen(o => !o)}>
        {children}
      </button>
      {open && (
        <span className={`pv-notice pv-notice-${align}`} role="note">
          <span>{control.text}</span>
          <span className="pv-notice-actions">
            {control.openAnyway && <a href={href} target="_blank" rel="noopener noreferrer">Open Pipeline Visualizer</a>}
            <button type="button" onClick={() => setOpen(false)}>Close</button>
          </span>
        </span>
      )}
    </span>
  );
}
