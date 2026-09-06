export type CompactGlassChromeLayout = "single" | "split";

interface CompactGlassChromeProps {
  layout: CompactGlassChromeLayout;
}

const SHAPES_BY_LAYOUT: Record<
  CompactGlassChromeLayout,
  readonly ("single" | "left" | "right")[]
> = {
  single: ["single"],
  split: ["left", "right"],
};

/**
 * The only DOM implementation of the permanently visible compact material.
 *
 * Frost sits below the SDF canvas and the spectrum rim sits above it. The
 * floating placement exposes one capsule; the camera-safe placement exposes
 * two copies of that same capsule primitive around the physical camera gap.
 * Keeping both placements in this component prevents their material stacks
 * from drifting apart again.
 */
export function CompactGlassChrome({ layout }: CompactGlassChromeProps) {
  const shapes = SHAPES_BY_LAYOUT[layout];

  return (
    <>
      <span
        className="widget-compact-glass-layer widget-compact-glass-layer--frost"
        data-compact-glass-chrome="shared-v1"
        data-compact-glass-layout={layout}
        aria-hidden="true"
      >
        {shapes.map((shape) => (
          <span
            className={`widget-compact-glass-shape widget-compact-glass-shape--${shape}`}
            data-compact-glass-shape={shape}
            key={shape}
          >
            <span className="widget-compact-spectrum-frost" />
          </span>
        ))}
      </span>

      <span
        className="widget-compact-glass-layer widget-compact-glass-layer--rim"
        data-compact-glass-chrome="shared-v1"
        data-compact-glass-layout={layout}
        aria-hidden="true"
      >
        {shapes.map((shape) => (
          <span
            className={`widget-compact-glass-shape widget-compact-glass-shape--${shape}`}
            data-compact-glass-shape={shape}
            key={shape}
          >
            <span className="widget-compact-spectrum-frame">
              <span className="widget-compact-spectrum-flow" />
            </span>
          </span>
        ))}
      </span>
    </>
  );
}
