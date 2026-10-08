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

export const securityHeadersMiddleware = secureHeaders({
  contentSecurityPolicy: CONTENT_SECURITY_POLICY,
  xFrameOptions: "DENY",
  // Browsers ignore it over plain HTTP; no includeSubDomains (other subdomains may not be HTTPS)
  strictTransportSecurity: "max-age=15552000",
  referrerPolicy: "strict-origin-when-cross-origin",
  // Google sign-in uses full-page redirects, Turnstile an iframe: neither needs a cross-origin opener
  crossOriginOpenerPolicy: "same-origin",
  crossOriginResourcePolicy: "same-origin",
  permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
});
