import { BlockList, isIP } from 'node:net';

/**
 * Whether a URL taken from a publisher’s data may be fetched from inside the
 * cluster: a web URL that does not name a private, loopback or link-local address
 * or a cluster-internal host.
 *
 * This looks only at the URL, so it cannot see a public name resolving to a private
 * address, or a redirect to one. It stops the plain case, and a cluster egress
 * policy has to cover the rest.
 */
export function isPublicWebUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(host);
  if (family === 4) {
    return !PRIVATE_ADDRESSES.check(host, 'ipv4');
  }
  if (family === 6) {
    return !PRIVATE_ADDRESSES.check(host, 'ipv6');
  }
  // A single label is a Kubernetes service or a machine on the local network.
  return host.includes('.') && !INTERNAL_SUFFIX.test(host);
}

const INTERNAL_SUFFIX = /\.(localhost|local|internal|svc)$/;

const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}
