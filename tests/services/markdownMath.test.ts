/** LaTeX extraction for Markdown answers (public/js/markdown-math.js) and the KaTeX options it uses. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import katex from "katex";

// The file is a browser script; load it the way a page would, with a CommonJS-style export
const sandbox: any = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL("../../public/js/markdown-math.js", import.meta.url), "utf8"), sandbox);
const { protectMath, KATEX_OPTIONS } = sandbox.module.exports;

const show = (src: string) => {
  const r = protectMath(src);
  // Copy out of the sandbox realm so deepEqual compares plain values
  return {
    text: r.text.replace(/MATHPH\w+?X(\d+)X/g, "[$1]"),
    blocks: Array.from(r.blocks, (b: any) => `${b.display ? "D" : "I"}:${b.tex}`),
  };
};

test("display and inline math are taken out before Markdown", () => {
  assert.deepEqual(show("Rumus $E = mc^2$ dan $$\\int_0^1 x^2\\,dx$$"), {
    text: "Rumus [0] dan [1]",
    blocks: ["I:E = mc^2", "D:\\int_0^1 x^2\\,dx"],
  });
  assert.deepEqual(show("\\(a_1 + a_2\\) lalu \\[\\sum_{i=1}^n i\\]"), {
    text: "[0] lalu [1]",
    blocks: ["I:a_1 + a_2", "D:\\sum_{i=1}^n i"],
  });
  assert.deepEqual(show("$$\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n$$").blocks, ["D:x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}"]);
});

test("dollar amounts and stray dollars stay text", () => {
  for (const s of ["Harga $5 and $10", "biaya US$5 per bulan", "$ spaced $", "$x$5", "Rp5.000 atau $3,50"]) {
    assert.deepEqual(show(s).blocks, [], s);
  }
});

test("code spans and fenced code are never treated as math", () => {
  assert.deepEqual(show("kode `$x$` dan $a_1$"), { text: "kode `$x$` dan [0]", blocks: ["I:a_1"] });
  assert.deepEqual(show("```\n$y$ dan $$z$$\n```\n$w$").blocks, ["I:w"]);
});

test("unfinished math while streaming stays text until it is closed", () => {
  assert.deepEqual(show("Hasilnya $$\\int_0^1 x").blocks, []);
  assert.deepEqual(show("Hasilnya $$\\int_0^1 x$$").blocks, ["D:\\int_0^1 x"]);
});

test("placeholders are words Markdown leaves alone and differ per call", () => {
  const a = protectMath("$a_1$").text;
  const b = protectMath("$a_1$").text;
  assert.match(a, /^MATHPH[a-z0-9]+X0X$/);
  assert.notEqual(a, b);
});

test("KaTeX options: no links from \\href, bounded macro expansion, no throw", () => {
  const link = katex.renderToString("\\href{javascript:alert(1)}{klik}", KATEX_OPTIONS);
  // The TeX source is kept (escaped) in the MathML annotation; what matters is that no link is made
  assert.doesNotMatch(link, /<a\b|\bhref=/);

  const started = Date.now();
  const bomb = katex.renderToString("\\def\\a{\\a\\a}\\a", KATEX_OPTIONS);
  assert.ok(Date.now() - started < 1000, "expansion is capped");
  assert.match(bomb, /katex-error/);

  const html = katex.renderToString("\\frac{a}{b}", { ...KATEX_OPTIONS, displayMode: true });
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<math/, "MathML is included for screen readers");
});
