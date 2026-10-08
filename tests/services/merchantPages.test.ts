/**
 * What Midtrans checks before activating a merchant website: products with
 * descriptions and prices you can buy, terms and a refund policy, a business
 * contact, prices in Rupiah, and payment that doesn't leave the site.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderPricingPage, CONTACT_EMAIL } from "../../src/controllers/pricingPage.js";
import { getCatalog } from "../../src/services/paymentService.js";

const page = (name: string) => readFileSync(`public/${name}`, "utf8");

test("the pricing page lists every product with description, Rupiah price and a buy link", () => {
  const html = renderPricingPage();
  for (const item of getCatalog()) {
    assert.ok(html.includes(item.name), item.name);
    assert.ok(html.includes(`Rp${item.priceIdr.toLocaleString("id-ID")}`), `${item.name} price`);
    assert.ok(html.includes(`/checkout.html?product=${item.code}`), `${item.name} buy link`);
  }
  assert.match(html, /Rp0/, "free plan");
  assert.ok(html.includes(`mailto:${CONTACT_EMAIL}`));
  assert.match(html, /\/syarat-ketentuan\.html/);
  assert.match(html, /\/kebijakan-pengembalian\.html/);
});

test("terms and refund policy pages exist, link each other and show the contact", () => {
  const terms = page("syarat-ketentuan.html");
  const refund = page("kebijakan-pengembalian.html");
  assert.match(terms, /Syarat &amp; Ketentuan/);
  assert.match(terms, /Hukum yang Berlaku/);
  assert.match(terms, /kebijakan-pengembalian\.html/);
  assert.match(refund, /Kebijakan Pengembalian Dana/);
  assert.match(refund, /syarat-ketentuan\.html/);
  for (const html of [terms, refund]) assert.ok(html.includes(`mailto:${CONTACT_EMAIL}`));
});

test("public pages link pricing, terms, refund policy and contact", () => {
  for (const name of ["index.html", "about.html", "login.html", "checkout.html"]) {
    const html = page(name);
    for (const link of ["/harga.html", "/syarat-ketentuan.html", "/kebijakan-pengembalian.html", `mailto:${CONTACT_EMAIL}`]) {
      assert.ok(html.includes(link), `${name} should link ${link}`);
    }
  }
  assert.match(page("register.html"), /syarat-ketentuan\.html/, "consent on sign-up");
});

test("prices are in Rupiah: no dollar prices or USD offers on public pages", () => {
  for (const name of ["index.html", "about.html", "checkout.html", "syarat-ketentuan.html", "kebijakan-pengembalian.html"]) {
    const html = page(name);
    assert.doesNotMatch(html, /"priceCurrency":\s*"(?!IDR)/, name);
    assert.doesNotMatch(html, /(?:US)?\$\s?\d/, name);
  }
  assert.doesNotMatch(renderPricingPage(), /(?:US)?\$\s?\d/);
});

test("payment opens on our checkout page (Snap popup); Midtrans' page is only an explicit fallback", () => {
  const checkout = page("checkout.html");
  assert.match(checkout, /snap\.pay\(/);
  assert.match(checkout, /SNAP_HOSTS = \['app\.midtrans\.com', 'app\.sandbox\.midtrans\.com'\]/);
  assert.doesNotMatch(checkout, /location\.(?:assign|href\s*=|replace)\([^)]*redirect_url/);
  const dashboard = page("dashboard.html");
  assert.match(dashboard, /\/checkout\.html\?product=/);
  assert.doesNotMatch(dashboard, /window\.location\.assign\(url\.href\)/, "dashboard no longer jumps to Midtrans");
});
