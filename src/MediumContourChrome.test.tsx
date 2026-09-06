import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediumContourChrome } from "./MediumContourChrome";

describe("MediumContourChrome", () => {
  it("uses the same contour path for the glass fill, rim and spectrum edge", () => {
    const path = "M 24 3 H 180 V 32 H 380 V 3 H 536 V 216 H 24 Z";
    const markup = renderToStaticMarkup(
      <MediumContourChrome width={560} height={224} path={path} />,
    );

    expect(markup.match(new RegExp(`d="${path}"`, "g"))).toHaveLength(4);
    expect(markup).toContain("widget-medium-material-shape");
    expect(markup).toContain("widget-spectrum-edge--path");
    expect(markup).not.toContain("widget-crown-overlay-material-wing");
  });
});
