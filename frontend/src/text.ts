const GREEK_SYMBOLS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  sigma: "σ",
  phi: "φ",
  psi: "ψ",
  omega: "ω",
};

/**
 * Converts the small Markdown/LaTeX subset commonly found in paper titles
 * into safe display text. The result is rendered as a normal React string.
 */
export function inlineScientificText(value: string): string {
  let text = value.trim();

  text = text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\\\((.*?)\\\)/g, "$1")
    .replace(/\\\[(.*?)\\\]/g, "$1");

  for (let pass = 0; pass < 3; pass += 1) {
    text = text.replace(
      /\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g,
      "$1",
    );
  }

  text = text
    .replace(/\${1,2}([^$]+?)\${1,2}/g, "$1")
    .replace(
      /\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|phi|psi|omega)\b/g,
      (_, symbol: string) => GREEK_SYMBOLS[symbol] || symbol,
    )
    .replace(/\\([_%&#$])/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+([–—-])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  return text || value;
}

/**
 * Promotes single-line $$...$$ equations to display math. remark-math treats
 * same-line double-dollar delimiters as inline math, where commands such as
 * \tag are invalid even though the underlying LaTeX is valid.
 */
export function normalizeScientificMarkdown(value: string): string {
  return value.replace(
    /\$\$[ \t]*([^\n]*?)[ \t]*\$\$/g,
    (_, equation: string) => `$$\n${equation.trim()}\n$$`,
  );
}
