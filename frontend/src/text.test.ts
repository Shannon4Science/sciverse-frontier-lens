import { describe, expect, it } from "vitest";

import { inlineScientificText, normalizeScientificMarkdown } from "./text";

describe("inlineScientificText", () => {
  it("cleans inline math markers used in paper titles", () => {
    expect(
      inlineScientificText(
        "A $K$ –variate Time Series Is Worth $K$ Words",
      ),
    ).toBe("A K–variate Time Series Is Worth K Words");
  });

  it("normalizes common Markdown and LaTeX title syntax", () => {
    expect(
      inlineScientificText("**Informer**: \\text{Fast} $\\alpha$ Forecasting"),
    ).toBe("Informer: Fast α Forecasting");
  });

  it("removes HTML rather than rendering it", () => {
    expect(
      inlineScientificText("<img src=x onerror=alert(1)>Safe title"),
    ).toBe("Safe title");
  });
});

describe("normalizeScientificMarkdown", () => {
  it("promotes same-line double-dollar equations to display math", () => {
    expect(
      normalizeScientificMarkdown(
        "$$ \\left\\|W_m\\right\\|_F = 1 \\tag{1} $$",
      ),
    ).toBe(
      "$$\n\\left\\|W_m\\right\\|_F = 1 \\tag{1}\n$$",
    );
  });

  it("preserves inline and already multiline math", () => {
    expect(
      normalizeScientificMarkdown(
        "Inline $W_m$.\n\n$$\n\\sum_i x_i\n$$",
      ),
    ).toBe(
      "Inline $W_m$.\n\n$$\n\\sum_i x_i\n$$",
    );
  });
});
