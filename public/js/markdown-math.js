/**
 * Math in Markdown answers, rendered with KaTeX.
 *
 * LaTeX between $$…$$, \[…\], \(…\) or $…$ is cut out before Markdown parsing
 * (so marked can't turn _ and * into emphasis or eat backslashes), replaced by
 * a placeholder word, and rendered with KaTeX after the HTML is sanitized.
 * Placeholders are only expanded in text, never inside attributes, and the
 * result is sanitized again. Code spans and fenced code blocks are left alone.
 *
 * Browser: window.MarkdownMath. Node (tests): module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MarkdownMath = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const KATEX_OPTIONS = {
    throwOnError: false,
    // No \href, \url, \htmlClass, \includegraphics, …: input comes from the model
    trust: false,
    strict: "ignore",
    maxSize: 20,
    maxExpand: 500,
    output: "htmlAndMathml",
  };
  const MAX_TEX_LENGTH = 2000;

  // Fenced code blocks and inline code spans are never scanned for math
  const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

  // Order matters: display forms first. Inline $…$ follows the Pandoc rule:
  // no space after the opening $, none before the closing $, and the closing
  // $ is not followed by a digit (so "$5 and $10" stays text).
  const MATH = new RegExp(
    [
      String.raw`\$\$([\s\S]+?)\$\$`,
      String.raw`\\\[([\s\S]+?)\\\]`,
      String.raw`\\\(([\s\S]+?)\\\)`,
      String.raw`(?<![\\$\w])\$(?![\s$])((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)`,
    ].join("|"),
    "g"
  );

  function nonce() {
    return Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, "x");
  }

  /**
   * Replace math with placeholder words. Returns the text to give to the
   * Markdown parser and the extracted blocks.
   */
  function protectMath(src) {
    const id = nonce();
    const blocks = [];
    const token = (i) => `MATHPH${id}X${i}X`;
    const protect = (segment) =>
      segment.replace(MATH, (whole, display1, display2, inline1, inline2) => {
        const tex = display1 ?? display2 ?? inline1 ?? inline2;
        if (!tex || !tex.trim() || tex.length > MAX_TEX_LENGTH) return whole;
        blocks.push({ tex: tex.trim(), display: display1 !== undefined || display2 !== undefined, source: whole });
        return token(blocks.length - 1);
      });

    let out = "";
    let last = 0;
    String(src).replace(CODE, (code, _g, offset) => {
      out += protect(src.slice(last, offset)) + code;
      last = offset + code.length;
      return code;
    });
    out += protect(String(src).slice(last));
    return { text: out, blocks, pattern: new RegExp(`MATHPH${id}X(\\d+)X`, "g") };
  }

  function renderTex(katex, block) {
    try {
      return katex.renderToString(block.tex, { ...KATEX_OPTIONS, displayMode: block.display });
    } catch {
      return null;
    }
  }

  /**
   * Expand placeholders in sanitized HTML (browser only: uses the DOM).
   * `katex` and `sanitize` are optional; without KaTeX the original LaTeX is shown.
   */
  function renderMath(html, protectedResult, katex, sanitize) {
    const { blocks, pattern } = protectedResult;
    if (!blocks.length) return html;

    const template = document.createElement("template");
    template.innerHTML = html;

    // Attributes (e.g. a link URL): put the original text back, never markup
    for (const el of template.content.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) {
        if (pattern.test(attr.value)) {
          pattern.lastIndex = 0;
          el.setAttribute(attr.name, attr.value.replace(pattern, (_, i) => blocks[i]?.source ?? ""));
        }
        pattern.lastIndex = 0;
      }
    }

    // Text: split around placeholders and insert rendered math
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      const value = node.nodeValue;
      pattern.lastIndex = 0;
      if (!pattern.test(value)) continue;
      pattern.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let last = 0;
      let match;
      while ((match = pattern.exec(value))) {
        fragment.append(value.slice(last, match.index));
        const block = blocks[Number(match[1])];
        const rendered = block && katex ? renderTex(katex, block) : null;
        if (rendered) {
          const holder = document.createElement("span");
          holder.className = block.display ? "math-display" : "math-inline";
          holder.innerHTML = rendered;
          fragment.append(holder);
        } else {
          fragment.append(block ? block.source : match[0]);
        }
        last = match.index + match[0].length;
      }
      fragment.append(value.slice(last));
      node.replaceWith(fragment);
    }

    const out = template.innerHTML;
    return sanitize ? sanitize(out) : out;
  }

  return { protectMath, renderMath, KATEX_OPTIONS };
});
