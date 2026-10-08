import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";

/**
 * Security headers for every response (pages and API).
 *
 * The Content-Security-Policy is a site-wide baseline: it lists every origin
 * any page loads from, and pages that need less narrow it further with their
 * own <meta> CSP (both are enforced). 'unsafe-inline' stays until the inline
 * scripts and onclick handlers move to files; the policy still pins script
 * origins, blocks plugins, <base> hijacking, off-site form posts and framing
 * (clickjacking of e.g. the admin page).
 */
export const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'",
    "'unsafe-inline'",
    "https://cdn.tailwindcss.com",
    "https://cdn.jsdelivr.net",
    "https://challenges.cloudflare.com",
  ],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
  imgSrc: ["'self'", "data:", "blob:"],
  connectSrc: ["'self'", "https://cdn.jsdelivr.net", "https://challenges.cloudflare.com"],
  frameSrc: ["https://challenges.cloudflare.com"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

/**
 * Midtrans Snap.js (payment popup) needs these hosts, per Midtrans' CSP
 * guidance (*.midtrans.com, *.veritrans.co.id, cloudfront, and its analytics).
 * They are allowed only on the checkout page, which is the only page that
 * loads Snap.js, so the rest of the site keeps the strict policy.
 * https://docs.midtrans.com/docs/snap-advanced-feature
 */
const MIDTRANS_HOSTS = [
  "https://app.midtrans.com",
  "https://app.sandbox.midtrans.com",
  "https://*.midtrans.com",
  "https://*.veritrans.co.id",
  "https://*.cloudfront.net",
];
const MIDTRANS_ANALYTICS = ["https://*.mixpanel.com", "https://*.google-analytics.com"];

export const CHECKOUT_CONTENT_SECURITY_POLICY = {
  ...CONTENT_SECURITY_POLICY,
  scriptSrc: [...CONTENT_SECURITY_POLICY.scriptSrc, ...MIDTRANS_HOSTS, ...MIDTRANS_ANALYTICS],
  styleSrc: [...CONTENT_SECURITY_POLICY.styleSrc, ...MIDTRANS_HOSTS],
  imgSrc: [...CONTENT_SECURITY_POLICY.imgSrc, ...MIDTRANS_HOSTS, ...MIDTRANS_ANALYTICS],
  connectSrc: [...CONTENT_SECURITY_POLICY.connectSrc, ...MIDTRANS_HOSTS, ...MIDTRANS_ANALYTICS],
  frameSrc: [...CONTENT_SECURITY_POLICY.frameSrc, ...MIDTRANS_HOSTS],
};

const COMMON_HEADERS = {
  xFrameOptions: "DENY",
  // Browsers ignore it over plain HTTP; no includeSubDomains (other subdomains may not be HTTPS)
  strictTransportSecurity: "max-age=15552000",
  referrerPolicy: "strict-origin-when-cross-origin",
  crossOriginResourcePolicy: "same-origin",
  permissionsPolicy: { camera: [] as string[], microphone: [] as string[], geolocation: [] as string[] },
};

const siteHeaders = secureHeaders({
  ...COMMON_HEADERS,
  contentSecurityPolicy: CONTENT_SECURITY_POLICY,
  // Google sign-in uses full-page redirects, Turnstile an iframe: neither needs a cross-origin opener
  crossOriginOpenerPolicy: "same-origin",
});

const checkoutHeaders = secureHeaders({
  ...COMMON_HEADERS,
  contentSecurityPolicy: CHECKOUT_CONTENT_SECURITY_POLICY,
  // Some payment methods (e.g. 3DS, e-wallet deeplinks) open windows that talk back to the popup
  crossOriginOpenerPolicy: "same-origin-allow-popups",
});

export function isCheckoutPath(path: string): boolean {
  return path === "/checkout" || path === "/checkout.html";
}

export const securityHeadersMiddleware: MiddlewareHandler = (c, next) =>
  isCheckoutPath(c.req.path) ? checkoutHeaders(c, next) : siteHeaders(c, next);
