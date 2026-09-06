import type { CSSProperties } from "react";
import brandLogoUrl from "../src-tauri/icons/app-icon.svg";
import "./BrandLogo.css";

type BrandLogoProps = {
  className?: string;
  label?: string;
  size?: number;
};

/**
 * The in-product representation of the packaged application icon. Importing
 * the same SVG used to generate `.icns`, `.ico`, and PNG assets prevents the
 * window chrome and packaged app from drifting into different logos.
 */
export function BrandLogo({ className = "", label, size = 36 }: BrandLogoProps) {
  return (
    <img
      className={`brand-logo${className ? ` ${className}` : ""}`}
      src={brandLogoUrl}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      width={size}
      height={size}
      draggable={false}
      style={{ "--brand-logo-size": `${size}px` } as CSSProperties}
    />
  );
}
