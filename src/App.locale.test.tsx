import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductOverview } from "./App";

describe("main-window locale", () => {
  it("renders the product guide in Simplified Chinese", () => {
    const markup = renderToStaticMarkup(<ProductOverview locale="zh-CN" />);

    expect(markup).toContain("Codex 本地观察台");
    expect(markup).toContain("安全与隐私");
    expect(markup).toContain("项目完成度只依据用户保存的里程碑计算");
    expect(markup).not.toContain("Security and privacy");
  });

  it("renders semantic English copy without weakening data boundaries", () => {
    const markup = renderToStaticMarkup(<ProductOverview locale="en-US" />);

    expect(markup).toContain("Codex Local Observer");
    expect(markup).toContain("Security and privacy");
    expect(markup).toContain("Project progress comes only from milestones you save");
    expect(markup).toContain("local estimates are never presented as official results");
    expect(markup).not.toContain("安全与隐私");
  });
});
