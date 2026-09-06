import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandLogo } from "./BrandLogo";

describe("BrandLogo", () => {
  it("uses the packaged app icon source and is decorative by default", () => {
    const markup = renderToStaticMarkup(<BrandLogo size={32} />);

    expect(markup).toContain("data:image/svg+xml");
    expect(markup).toContain("%23d45c2f");
    expect(markup).toContain('width="32"');
    expect(markup).toContain('alt=""');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("supports a single accessible brand label when used standalone", () => {
    const markup = renderToStaticMarkup(<BrandLogo label="Codex Local Observer" />);

    expect(markup).toContain('alt="Codex Local Observer"');
    expect(markup).not.toContain('aria-hidden="true"');
  });
});
