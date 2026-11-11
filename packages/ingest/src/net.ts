/**
 * Fetches for links a stranger can type: every hop (the link and each redirect) must resolve to a public
 * address, so a page cannot point the server at itself, its cloud metadata service or a private network.
 * EXPLANIMATE_ALLOW_PRIVATE_URLS=1 (or the CLI's --allow-private) lifts it for local intranet pages.
 */
import dns from "node:dns/promises";
import net from "node:net";

export class PrivateAddressError extends Error {}

/**
 * Loopback, private, link-local, carrier-grade NAT, multicast and other non-public ranges, IPv4 and IPv6.
 * In 192.0.0.0/16 only two /24s are reserved: 192.0.0.0/24 (IETF protocol assignments, minus the globally
 * reachable anycast 192.0.0.9 and 192.0.0.10, per the IANA special-purpose registry) and 192.0.2.0/24
 * (TEST-NET-1). The rest is public, WordPress.com among it (192.0.78.0/24).
 */
export function privateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (net.isIPv4(v4)) {
    const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && ((c === 0 && d !== 9 && d !== 10) || c === 2)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (!net.isIPv6(ip)) return true;
  const h = ip.toLowerCase();
  // ::, ::1, unique local fc00::/7, link-local fe80::/10, multicast ff00::/8, and IPv4-mapped forms in hex
  return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h) || /^::ffff:[0-9a-f]+:[0-9a-f]+$/.test(h);
}

async function assertPublic(url: URL, isPrivate: (ip: string) => boolean): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new PrivateAddressError(`Only http and https links can be read (got ${url.protocol}).`);
  if (process.env.EXPLANIMATE_ALLOW_PRIVATE_URLS === "1") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error(`Could not find the site ${host}. Check the link.`);
  if (addrs.some(isPrivate))
    throw new PrivateAddressError(
      `That link points at a private network address (${host}), which is not read by default. To read a local intranet, set EXPLANIMATE_ALLOW_PRIVATE_URLS=1 (or pass --allow-private to the CLI). If every site fails like this, the host's DNS answers with proxy addresses; give such a host real DNS instead.`,
    );
}

/** fetch() that checks each hop's address and follows at most `hops` redirects itself. The response's url is the final one. */
export async function publicFetch(link: string, init: RequestInit = {}, hops = 5, isPrivate = privateAddress): Promise<Response> {
  let url = new URL(link);
  for (let i = 0; ; i++) {
    await assertPublic(url, isPrivate);
    const r = await fetch(url, { ...init, redirect: "manual" });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!loc) {
      Object.defineProperty(r, "url", { value: url.href });
      return r;
    }
    if (i >= hops) throw new Error("That link redirects too many times. Link to the page itself.");
    await r.body?.cancel().catch(() => {});
    url = new URL(loc, url);
  }
}
