import { test } from "node:test";
import assert from "node:assert/strict";
import { privateAddress, publicFetch, PrivateAddressError } from "../src/net.ts";

test("private, loopback, link-local and metadata addresses are spotted, public ones pass", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "192.0.0.1",
    "192.0.0.170",
    "192.0.2.1",
    "198.51.100.7",
    "203.0.113.9",
    "198.18.0.1",
  ])
    assert.ok(privateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "140.82.112.3", "172.32.0.1", "2606:4700::1111"]) assert.ok(!privateAddress(ip), ip);
});

test("192.0.0.0/16 is public outside its two reserved /24s, so WordPress.com sites can be read (#108)", () => {
  // WordPress.com and its hosted blogs resolve into Automattic's 192.0.78.0/24
  for (const ip of ["192.0.78.9", "192.0.78.17", "192.0.78.24", "192.0.1.1", "192.0.3.1", "192.0.255.255", "::ffff:192.0.78.9"])
    assert.ok(!privateAddress(ip), ip);
  // the two anycast addresses IANA marks globally reachable inside 192.0.0.0/24
  for (const ip of ["192.0.0.9", "192.0.0.10"]) assert.ok(!privateAddress(ip), ip);
  for (const ip of ["192.0.0.0", "192.0.0.8", "192.0.0.11", "192.0.0.255", "192.0.2.0", "192.0.2.255"]) assert.ok(privateAddress(ip), ip);
});

test("a link to the server's own network is refused before any request", async () => {
  delete process.env.EXPLANIMATE_ALLOW_PRIVATE_URLS;
  for (const u of ["http://127.0.0.1:3000/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"]) {
    await assert.rejects(publicFetch(u), PrivateAddressError, u);
  }
  await assert.rejects(publicFetch("file:///etc/passwd"), /Only http and https/);
});

test("a redirect into the private network is refused at the hop", async () => {
  const http = await import("node:http");
  const srv = http
    .createServer((_q, s) => {
      s.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      s.end();
    })
    .listen(0);
  const port = (srv.address() as { port: number }).port;
  // the test server is on loopback, so only 127.0.0.1 counts as public here
  const r = await publicFetch(`http://127.0.0.1:${port}/`, {}, 5, (ip) => ip !== "127.0.0.1" && privateAddress(ip)).catch((e) => e);
  srv.close();
  assert.ok(r instanceof PrivateAddressError, String(r));
});
