import { useId } from "react";

function SpectrumGradientStops() {
  return (
    <>
      <stop offset="0" stopColor="#ff375f" />
      <stop offset="0.14" stopColor="#ff9f0a" />
      <stop offset="0.28" stopColor="#ffd60a" />
      <stop offset="0.42" stopColor="#30d158" />
      <stop offset="0.56" stopColor="#64d2ff" />
      <stop offset="0.7" stopColor="#0a84ff" />
      <stop offset="0.84" stopColor="#bf5af2" />
      <stop offset="1" stopColor="#ff375f" />
    </>
  );
}

/**
 * The one optical chrome used by both the complete medium surface and the
 * always-front top crop. Keeping the fill and spectrum paths together means
 * the companion window is a crop of the original surface, not a second UI.
 */
export function MediumContourChrome({
  width,
  height,
  path,
}: {
  width: number;
  height: number;
  path: string;
}) {
  const materialGradientId = `widget-medium-glass-${useId().replace(/:/g, "")}`;
  const spectrumGradientId = `widget-medium-spectrum-${useId().replace(/:/g, "")}`;

  return (
    <>
      <div className="widget-medium-material" aria-hidden="true">
        <svg
          className="widget-medium-material-shape"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={materialGradientId} x1="0" y1="0" x2="1" y2="1">
              <stop className="widget-medium-glass-stop widget-medium-glass-stop--highlight" offset="0" />
              <stop className="widget-medium-glass-stop widget-medium-glass-stop--middle" offset="0.48" />
              <stop className="widget-medium-glass-stop widget-medium-glass-stop--shade" offset="1" />
            </linearGradient>
          </defs>
          <path
            className="widget-medium-material-fill"
            d={path}
            fill={`url(#${materialGradientId})`}
          />
          <path className="widget-medium-material-rim" d={path} />
        </svg>
      </div>

      <svg
        className="widget-spectrum-edge widget-spectrum-edge--path"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id={spectrumGradientId}
            x1="0"
            y1="0"
            x2={width}
            y2={height}
            gradientUnits="userSpaceOnUse"
          >
            <SpectrumGradientStops />
          </linearGradient>
        </defs>
        <path
          className="widget-spectrum-edge-path widget-spectrum-edge-path--base"
          d={path}
          pathLength="1"
          fill="none"
          stroke={`url(#${spectrumGradientId})`}
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          className="widget-spectrum-edge-path widget-spectrum-edge-path--flow"
          d={path}
          pathLength="1"
          fill="none"
          stroke={`url(#${spectrumGradientId})`}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </>
  );
}
