/**
 * The page's Content-Security-Policy. The policy itself lives in the core
 * (`core/gateway/csp.ts`) because the gateway serves the same page and the core
 * may not import a shell; the desktop shell re-exports it unchanged.
 */
export { contentSecurityPolicy } from "../core/gateway/csp";

/** Whether a URL is one the CSP above is meant to cover. */
export function isPageUrl(url: string, pageOrigin: string): boolean {
  return url === pageOrigin || url.startsWith(`${pageOrigin}/`);
}
