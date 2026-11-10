/**
 * Network boundary: URL safety checks, bounded fetching, and a search adapter
 * over the Harness web service.
 *
 * Every fetch is SSRF-guarded (loopback, private ranges, link-local and cloud
 * metadata are refused, and every redirect hop is re-validated), size- and time-bounded, and sends no credentials.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Error codes shared by the whole plugin. */
export const ERROR_CODES = Object.freeze({
  SEARCH_PROVIDER_ERROR: 'SEARCH_PROVIDER_ERROR',
  FETCH_TIMEOUT: 'FETCH_TIMEOUT',
  FETCH_BLOCKED: 'FETCH_BLOCKED',
  CONTENT_EXTRACTION_FAILED: 'CONTENT_EXTRACTION_FAILED',
  DUPLICATE_ARTICLE: 'DUPLICATE_ARTICLE',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_INVALID_JSON: 'LLM_INVALID_JSON',
  LLM_TRUNCATED: 'LLM_TRUNCATED',
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  EVIDENCE_NOT_FOUND: 'EVIDENCE_NOT_FOUND',
  DATABASE_ERROR: 'DATABASE_ERROR',
  STORAGE_ERROR: 'STORAGE_ERROR',
  INVALID_URL: 'INVALID_URL',
  DICTIONARY_NOT_FOUND: 'DICTIONARY_NOT_FOUND',
  DICTIONARY_PARSE_FAILED: 'DICTIONARY_PARSE_FAILED',
});

/** A plugin-owned, code-carrying failure with a safe user-facing message. */
export class ReaderError extends Error {
  /**
   * @param {string} code stable machine code.
   * @param {string} message safe summary for display.
   * @param {object} [details] optional structured detail.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ReaderError';
    this.code = code;
    this.details = details ?? {};
  }

  /** JSON-safe projection for RPC results and logs. */
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const PRIVATE_V4 = [
  [0, 0, 0, 0, 8], [10, 0, 0, 0, 8], [100, 64, 0, 0, 10], [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16], [172, 16, 0, 0, 12], [192, 0, 0, 0, 24], [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15], [198, 51, 100, 0, 24], [203, 0, 113, 0, 24], [224, 0, 0, 0, 4],
];

/** IPv4 predicates a deployment named as its proxy's synthetic addresses. */
let syntheticV4 = [];
/** IPv6 predicates for the same synthetic ranges. */
let syntheticV6 = [];

/** Parse `a.b.c.d/n` into a predicate over the 32-bit value. */
function cidrV4(cidr) {
  const [address, bitsText] = String(cidr).split('/');
  const parts = address.split('.').map(Number);
  const bits = Number.parseInt(bitsText ?? '32', 10);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)) || !Number.isInteger(bits)) return undefined;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  const base = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return (value) => (value & mask) === (base & mask);
}

/** Parse an IPv6 CIDR prefix into a predicate over the first two groups. */
function cidrV6(cidr) {
  const [address, bitsText] = String(cidr).split('/');
  const bits = Number.parseInt(bitsText ?? '128', 10);
  const groups = address.toLowerCase().split(':');
  if (groups.length < 2 || !Number.isInteger(bits)) return undefined;
  const prefix = groups.slice(0, 2).map((group) => Number.parseInt(group || '0', 16));
  if (prefix.some((group) => !Number.isInteger(group))) return undefined;
  return (candidate) => {
    const target = candidate.toLowerCase().split(':').slice(0, 2).map((group) => Number.parseInt(group || '0', 16));
    return target.every((group, index) => (group & 0xffff) === prefix[index]);
  };
}

/**
 * Declare synthetic DNS ranges that must be treated as public.
 *
 * A fake-IP proxy resolves every hostname into a fixed range; refusing those
 * would block all fetching. Only the ranges a deployment names are exempted,
 * and real private literals stay refused.
 * @param {{v4?: string[], v6?: string[]}} ranges CIDR strings.
 */
export function allowSyntheticRanges(ranges) {
  syntheticV4 = (ranges?.v4 ?? []).map(cidrV4).filter(Boolean);
  syntheticV6 = (ranges?.v6 ?? []).map(cidrV6).filter(Boolean);
}

/** Test an IPv4 address against the refused ranges. */
function refusedV4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const value = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  if (syntheticV4.some((matches) => matches(value))) return false;
  return PRIVATE_V4.some(([a, b, c, d, bits]) => {
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    return (value & mask) === (base & mask);
  });
}

/** Test an IPv6 address against loopback, ULA, link-local and metadata ranges. */
function refusedV6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return refusedV4(normalized.slice(7));
  if (syntheticV6.some((matches) => matches(normalized))) return false;
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  return false;
}

/** Refuse an IP literal that addresses the local machine or cloud metadata. */
export function isRefusedAddress(address) {
  const family = isIP(address);
  if (family === 4) return refusedV4(address);
  if (family === 6) return refusedV6(address);
  return true;
}

/**
 * Validate a URL: scheme, host shape, and (after resolution) its addresses.
 * @param {string} raw candidate URL.
 * @returns {Promise<URL>} validated URL.
 */
export async function assertSafeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ReaderError(ERROR_CODES.INVALID_URL, 'That does not look like a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, 'Only http and https links can be fetched.');
  }
  if (url.username || url.password) {
    throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, 'Links carrying credentials are refused.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  if (literal !== 0) {
    if (isRefusedAddress(host)) throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, 'That address is not reachable from this reader.');
    return url;
  }
  if (host === 'localhost' || host.endsWith('.local')) {
    throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, 'Local addresses are not reachable from this reader.');
  }
  let addresses;
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch {
    throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, `Could not resolve ${host}.`);
  }
  if (addresses.length === 0 || addresses.some((entry) => isRefusedAddress(entry.address))) {
    throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, `${host} resolves to an address this reader refuses.`);
  }
  return url;
}

/**
 * Fetch a feed or listing page as text, under the same URL-safety rules.
 *
 * `fetchArticle` insists on HTML because it extracts article prose; feeds are
 * XML, so this variant accepts any textual content type while keeping the
 * redirect re-validation, byte bound and timeout.
 * @param {string} raw url.
 * @param {AbortSignal} [signal] cancellation.
 * @param {number} [limit] maximum body size.
 * @param {object} [web] the Harness web service, used when it can reach the URL.
 * @returns {Promise<string>} response body.
 */
export async function fetchText(raw, signal, limit = 6 * 1024 * 1024, web) {
  // The Harness fetch provider reaches the deployment's own network path, so
  // it is tried first behind a fake-IP proxy.
  const viaHarness = await fetchViaHarness(web, raw, signal);
  if (viaHarness !== null) {
    if (viaHarness.status < 200 || viaHarness.status >= 300) {
      throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, `The site answered ${viaHarness.status}.`);
    }
    if (viaHarness.html.length > limit) {
      throw new ReaderError(ERROR_CODES.CONTENT_EXTRACTION_FAILED, 'That feed is too large to read.');
    }
    return viaHarness.html;
  }
  let current = await assertSafeUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ReaderError(ERROR_CODES.FETCH_TIMEOUT, 'The page took too long to load.')), TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: combined,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; EnglishReader/1.0)',
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5',
        },
      });
    } catch (error) {
      clearTimeout(timer);
      if (signal?.aborted) throw new ReaderError(ERROR_CODES.FETCH_TIMEOUT, 'The request was cancelled.');
      throw new ReaderError(ERROR_CODES.FETCH_TIMEOUT, `Could not reach ${current.host} (${error?.code ?? 'network error'}).`);
    }
    clearTimeout(timer);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, 'The site redirected without a destination.');
      current = await assertSafeUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, `${current.host} answered ${response.status}.`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > limit) throw new ReaderError(ERROR_CODES.CONTENT_EXTRACTION_FAILED, 'That feed is too large to read.');
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) throw new ReaderError(ERROR_CODES.CONTENT_EXTRACTION_FAILED, 'That feed is too large to read.');
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
  throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, 'The site redirected too many times.');
}

/**
 * Fetch one URL through the Harness web service when one is available.
 *
 * The Harness fetch provider is the deployment's own path to the network: it
 * already knows the profile's fake-IP ranges, so a hostname that the proxy
 * resolves into a synthetic address is still reachable. The plugin's own
 * fetcher cannot know that, so it refuses those addresses; using the Harness
 * service first is what makes discovery work behind a fake-IP proxy.
 *
 * @param {object} web `ctx.web` or undefined.
 * @param {string} url the URL to retrieve.
 * @param {AbortSignal} [signal] cancellation.
 * @returns {Promise<{url: string, status: number, html: string, contentType: string}|null>}
 *   the response, or null when the service is unavailable or the body is not
 *   textual (the caller then falls back to its own fetcher).
 */
export async function fetchViaHarness(web, url, signal) {
  if (!web || typeof web.fetch !== 'function') return null;
  try {
    const result = await web.fetch({ url }, signal);
    const body = result?.body;
    if (!body || typeof body.content !== 'string') return null;
    return {
      url: result.url ?? url,
      status: result.statusCode ?? 200,
      html: body.content,
      contentType: body.kind === 'html' ? 'text/html' : 'text/plain',
    };
  } catch {
    return null;
  }
}

/** Canonical form used for duplicate detection. */
export function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.*|fbclid|gclid|dclid|msclkid|ref|source|spm)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

/**
 * Fetch one URL with redirect re-validation, byte and time bounds.
 * @param {string} raw url.
 * @param {AbortSignal} [signal] cancellation.
 * @param {object} [web] the Harness web service, used when it can reach the URL.
 * @returns {Promise<{url: string, status: number, html: string, contentType: string}>} response facts.
 */
export async function fetchArticle(raw, signal, web) {
  // The Harness fetch provider knows the deployment's fake-IP ranges, so it is
  // tried first: behind such a proxy the plugin's own resolver sees a
  // synthetic address and would refuse the page.
  const viaHarness = await fetchViaHarness(web, raw, signal);
  if (viaHarness !== null) {
    if (viaHarness.status >= 300 && viaHarness.status < 400) {
      throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, 'The site redirected without a destination.');
    }
    if (viaHarness.status < 200 || viaHarness.status >= 300) {
      throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, `The site answered ${viaHarness.status}. It may be behind a paywall or login.`);
    }
    if (viaHarness.html.length > MAX_BYTES) {
      throw new ReaderError(ERROR_CODES.CONTENT_EXTRACTION_FAILED, 'That page is too large to import.');
    }
    if (!/text\/html|application\/xhtml|text\/plain/.test(viaHarness.contentType)
      && !/^<(!doctype|html)/i.test(viaHarness.html.trim())) {
      throw new ReaderError(ERROR_CODES.CONTENT_EXTRACTION_FAILED, 'That link is not an HTML article.');
    }
    return viaHarness;
  }
  let current = await assertSafeUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ReaderError(ERROR_CODES.FETCH_TIMEOUT, 'The page took too long to load.')), TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: combined,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; EnglishReader/1.0)', accept: 'text/html,application/xhtml+xml' },
      });
    } catch (error) {
      clearTimeout(timer);
      if (signal?.aborted) throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, 'The import was cancelled.');
      throw new ReaderError(ERROR_CODES.FETCH_TIMEOUT, controller.signal.aborted
        ? 'The page took too long to load.'
        : `Could not reach the site (${error?.code ?? 'network error'}).`);
    }
    clearTimeout(timer);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, 'The site redirected without a destination.');
      current = await assertSafeUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, `The site answered ${response.status}. It may be behind a paywall or login.`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) throw new ReaderError(ERROR_CODES.CONTENT_EXTRACTION_FAILED, 'That page is too large to import.');
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) throw new ReaderError(ERROR_CODES.CONTENT_EXTRACTION_FAILED, 'That page is too large to import.');
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    if (!/text\/html|application\/xhtml|text\/plain/.test(contentType) && !/^<(!doctype|html)/i.test(text.trim())) {
      throw new ReaderError(ERROR_CODES.CONTENT_EXTRACTION_FAILED, 'That link is not an HTML article.');
    }
    return { url: current.toString(), status: response.status, html: text, contentType };
  }
  throw new ReaderError(ERROR_CODES.FETCH_BLOCKED, 'The site redirected too many times.');
}

/**
 * Search the web through the Harness web service, degrading cleanly when the
 * profile has no provider.
 * @param {object} web `ctx.web` or undefined.
 * @param {string} query search text.
 * @param {number} limit max sources.
 * @returns {Promise<Array<object>>} candidate sources.
 */
export async function searchWeb(web, query, limit) {
  if (!web) throw new ReaderError(ERROR_CODES.SEARCH_PROVIDER_ERROR, 'No web search provider is configured in this Harness profile.');
  try {
    const result = await web.search({ query, maxResults: limit });
    return [...(result.sources ?? [])];
  } catch (error) {
    throw new ReaderError(ERROR_CODES.SEARCH_PROVIDER_ERROR, error?.code === 'WEB_PROVIDER_UNAVAILABLE'
      ? 'Web search is unavailable right now; import by URL instead.'
      : `Search failed: ${error?.message ?? 'unknown error'}`);
  }
}
