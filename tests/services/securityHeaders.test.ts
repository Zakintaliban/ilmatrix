import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import { CONTENT_SECURITY_POLICY, securityHeadersMiddleware } from "../../src/middleware/securityHeaders.js";

test("every response gets the security headers", async () => {
  const app = new Hono();
  app.use("*", securityHeadersMiddleware);
  app.get("/page", (c) => c.html("<p>hi</p>"));
  app.get("/api/x", (c) => c.json({ ok: true }));

  for (const path of ["/page", "/api/x"]) {
    const res = await app.request(path);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
    assert.match(csp, /form-action 'self'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("strict-transport-security"), "max-age=15552000");
    assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(res.headers.get("permissions-policy") ?? "", /camera=\(\)/);
  }
});

const PAGES = readdirSync("public").filter((f) => f.endsWith(".html") && !["app2.html", "app4.html"].includes(f));
const scriptTags = (html: string) => Array.from(html.matchAll(/<script\b[^>]*\bsrc="(https?:\/\/[^"]+)"[^>]*>/g));

test("external scripts are version-pinned with Subresource Integrity (except the Tailwind Play CDN)", () => {
  for (const page of PAGES) {
    const html = readFileSync(`public/${page}`, "utf8");
    for (const [tag, src] of scriptTags(html)) {
      if (src.startsWith("https://cdn.tailwindcss.com")) continue; // generated per request, can't be hashed (P1-13)
      assert.match(src, /@\d+\.\d+\.\d+\//, `${page}: ${src} must pin an exact version`);
      assert.match(tag, /\bintegrity="sha384-[A-Za-z0-9+/=]+"/, `${page}: ${src} needs integrity`);
      assert.match(tag, /\bcrossorigin="anonymous"/, `${page}: ${src} needs crossorigin`);
    }
  }
});

test("the CSP allows every script origin the pages use", () => {
  const allowed = new Set(CONTENT_SECURITY_POLICY.scriptSrc);
  for (const page of PAGES) {
    for (const [, src] of scriptTags(readFileSync(`public/${page}`, "utf8"))) {
      assert.ok(allowed.has(new URL(src).origin), `${page}: ${new URL(src).origin} is not in script-src`);
    }
  }
});
