import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { env } from '@/env'

/**
 * Validates a user-supplied base URL for `anthropic-compatible` / `openai-compatible`
 * credentials. http/https only — anything else is either a footgun (`file:`, `data:`) or not a
 * network endpoint at all.
 */

export const MAX_BASE_URL_LENGTH = 2048

export function normaliseBaseUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > MAX_BASE_URL_LENGTH) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname === '') return null
  if (url.username !== '' || url.password !== '') return null

  const pathname =
    url.pathname === '/'
      ? ''
      : url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname
  return `${url.origin}${pathname}${url.search}${url.hash}`
}

/*
 * ---------------------------------------------------------------------------------------------
 * Outbound target policy (SSRF).
 *
 * A stored base URL makes the server issue HTTP requests to wherever the user says, carrying
 * the user's key and a generation prompt, and streaming the reply back. Without a check that is
 * a way to reach the instance's own loopback services or a cloud metadata endpoint.
 *
 * The defaults are deliberately soft. Pointing a key at Ollama or vLLM on the LAN is a primary
 * use case, so private ranges (RFC 1918, CGNAT, IPv6 ULA) are allowed unless the operator sets
 * PROVIDER_BASE_URL_BLOCK_PRIVATE=true. What is refused always is what no legitimate model
 * server a *user* configures would be: the app host's own loopback, link-local (which is where
 * the metadata services live), the unspecified address, and multicast/reserved space.
 *
 * Known limitation — DNS rebinding: the hostname is resolved here, and resolved again by the
 * HTTP client when it connects. A hostile resolver can answer differently the second time. This
 * check stops pasted internal URLs and hostnames that plainly resolve inward; it is not a
 * substitute for egress filtering where that matters.
 *
 * The operator's own OPENAI_BASE_URL never passes through here — the operator controls the
 * process environment already, and pointing it at localhost is legitimate.
 * ---------------------------------------------------------------------------------------------
 */

export type BaseUrlTargetVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string }

export interface ResolvedAddress {
  readonly address: string
  readonly family: number
}

export type ResolveHost = (hostname: string) => Promise<readonly ResolvedAddress[]>

export interface BaseUrlTargetOptions {
  readonly blockPrivate: boolean
  /** Injected by tests; defaults to `dns.lookup` with `all: true`. */
  readonly resolve?: ResolveHost
}

const LOOPBACK_REASON = 'Base URL points at a loopback address on the server'
const LINK_LOCAL_REASON = 'Base URL points at a link-local or cloud metadata address'
const UNSPECIFIED_REASON = 'Base URL points at an unspecified, multicast or reserved address'
const PRIVATE_REASON =
  'Base URL points at a private network address, which this instance does not allow'

/** Names that resolve to metadata services inside a cloud VM, whatever DNS says elsewhere. */
const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  'instance-data',
  'instance-data.ec2.internal',
])

function subnets(entries: readonly (readonly [string, number, 'ipv4' | 'ipv6'])[]): BlockList {
  const list = new BlockList()
  for (const [network, prefix, family] of entries) list.addSubnet(network, prefix, family)
  return list
}

const LOOPBACK = subnets([
  ['127.0.0.0', 8, 'ipv4'],
  ['::1', 128, 'ipv6'],
])

const LINK_LOCAL_AND_METADATA = subnets([
  // 169.254.169.254 (AWS, GCP, Azure, OCI, DigitalOcean) lives here.
  ['169.254.0.0', 16, 'ipv4'],
  ['fe80::', 10, 'ipv6'],
  // Alibaba Cloud's metadata address sits inside CGNAT space, so it needs its own entry to be
  // refused even when private ranges are allowed.
  ['100.100.100.200', 32, 'ipv4'],
  // AWS's IPv6 metadata endpoint, inside ULA space for the same reason.
  ['fd00:ec2::254', 128, 'ipv6'],
])

const UNSPECIFIED_AND_RESERVED = subnets([
  ['0.0.0.0', 8, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
])

const PRIVATE = subnets([
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
])

const IPV4_MAPPED_PREFIX = '::ffff:'

/**
 * `::ffff:127.0.0.1` is 127.0.0.1 on the wire; classify it as the IPv4 address it carries rather
 * than trusting every runtime's BlockList to see through the mapping.
 */
function canonicalAddress(address: string): {
  readonly address: string
  readonly type: 'ipv4' | 'ipv6'
} {
  const lowered = address.toLowerCase()
  if (
    lowered.startsWith(IPV4_MAPPED_PREFIX) &&
    isIP(lowered.slice(IPV4_MAPPED_PREFIX.length)) === 4
  ) {
    return { address: lowered.slice(IPV4_MAPPED_PREFIX.length), type: 'ipv4' }
  }
  return { address: lowered, type: isIP(lowered) === 4 ? 'ipv4' : 'ipv6' }
}

/** Exported for tests: the verdict for one literal address. */
export function classifyAddress(address: string, blockPrivate: boolean): BaseUrlTargetVerdict {
  const canonical = canonicalAddress(address)
  if (LOOPBACK.check(canonical.address, canonical.type)) {
    return { allowed: false, reason: LOOPBACK_REASON }
  }
  if (LINK_LOCAL_AND_METADATA.check(canonical.address, canonical.type)) {
    return { allowed: false, reason: LINK_LOCAL_REASON }
  }
  if (UNSPECIFIED_AND_RESERVED.check(canonical.address, canonical.type)) {
    return { allowed: false, reason: UNSPECIFIED_REASON }
  }
  if (blockPrivate && PRIVATE.check(canonical.address, canonical.type)) {
    return { allowed: false, reason: PRIVATE_REASON }
  }
  return { allowed: true }
}

async function resolveWithDns(hostname: string): Promise<readonly ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

/**
 * Decides whether a (normalised) base URL may be used as an outbound target. Every address the
 * name resolves to must pass — one inward-facing A record among public ones is enough to refuse,
 * because the HTTP client may pick any of them.
 *
 * A name that does not resolve at all is allowed: the request will fail on its own, and refusing
 * it would reject hostnames that only exist on the network the app runs in (a compose service
 * name, a split-horizon DNS entry) whenever the check runs somewhere that cannot see them.
 */
export async function checkBaseUrlTarget(
  baseUrl: string,
  options: BaseUrlTargetOptions,
): Promise<BaseUrlTargetVerdict> {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return { allowed: false, reason: 'Invalid base URL' }
  }

  // URL keeps IPv6 literals bracketed, and a trailing dot is the same name to a resolver.
  const hostname = url.hostname
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase()

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { allowed: false, reason: LOOPBACK_REASON }
  }
  if (METADATA_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: LINK_LOCAL_REASON }
  }

  if (isIP(hostname) !== 0) return classifyAddress(hostname, options.blockPrivate)

  let addresses: readonly ResolvedAddress[]
  try {
    addresses = await (options.resolve ?? resolveWithDns)(hostname)
  } catch {
    return { allowed: true }
  }

  for (const { address } of addresses) {
    const verdict = classifyAddress(address, options.blockPrivate)
    if (!verdict.allowed) return verdict
  }
  return { allowed: true }
}

/** The instance's policy for user-supplied base URLs. */
export async function checkUserBaseUrlTarget(baseUrl: string): Promise<BaseUrlTargetVerdict> {
  return checkBaseUrlTarget(baseUrl, { blockPrivate: env.PROVIDER_BASE_URL_BLOCK_PRIVATE })
}

/**
 * Call-time counterpart of the store-time check, for keys saved before the check existed (or
 * before the operator tightened the policy). It logs and lets the call proceed: silently moving
 * a user off their own gateway would be worse than a warning an operator can act on, and the
 * store-time check already stops every new key. Never throws, never logs the URL's path or
 * query — only the host — since a gateway URL can carry a token.
 */
export function warnIfUnsafeStoredBaseUrl(baseUrl: string | undefined): void {
  if (baseUrl === undefined) return
  void checkUserBaseUrlTarget(baseUrl)
    .then((verdict) => {
      if (verdict.allowed) return
      let host = '(unparseable)'
      try {
        host = new URL(baseUrl).host
      } catch {
        // Keep the placeholder.
      }
      console.warn(
        `[enclave] a stored provider base URL targets a refused address (${verdict.reason}; host ${host}). Ask the user to replace the key.`,
      )
    })
    .catch(() => undefined)
}
