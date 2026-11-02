import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

export class AlertTransportError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export function alertDestination(env = process.env) {
  try {
    const url = new URL(env.ALERT_WEBHOOK_URL || "");
    const allowed = (env.ALERT_WEBHOOK_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443") ||
      isIP(url.hostname) ||
      !allowed.includes(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2001::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");

export function isPublicAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}

export type DeliveryResult = { status: number; retryAfter?: number };
/** Operator-configured HTTPS endpoint only. Pin the validated DNS address for the TLS connection; never follow redirects. */
export async function sendAlert(
  payload: unknown,
  deliveryId: string,
): Promise<DeliveryResult> {
  const url = alertDestination();
  if (!url) throw new AlertTransportError("DESTINATION_NOT_CONFIGURED");
  // DNS resolution and HTTPS share one deadline. A resolver which never settles
  // must not hold the worker indefinitely or start a late request after timeout.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    let addresses: LookupAddress[];
    try {
      addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
        const abort = () => reject(new AlertTransportError("DNS_FAILURE"));
        controller.signal.addEventListener("abort", abort, { once: true });
        lookup(url.hostname, { all: true }).then(
          (rows) => {
            controller.signal.removeEventListener("abort", abort);
            resolve(rows);
          },
          () => {
            controller.signal.removeEventListener("abort", abort);
            reject(new AlertTransportError("DNS_FAILURE"));
          },
        );
      });
    } catch {
      throw new AlertTransportError("DNS_FAILURE");
    }
    if (
      !addresses.length ||
      addresses.some((row) => !isPublicAddress(row.address))
    )
      throw new AlertTransportError("PRIVATE_ADDRESS_BLOCKED");
    const address = addresses[0];
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 4096)
      throw new AlertTransportError("PAYLOAD_TOO_LARGE");
    return await new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "POST",
          family: address.family,
          servername: url.hostname,
          lookup: (_hostname, _options, callback) =>
            callback(null, address.address, address.family),
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "Idempotency-Key": deliveryId,
            ...(process.env.ALERT_WEBHOOK_TOKEN
              ? { Authorization: `Bearer ${process.env.ALERT_WEBHOOK_TOKEN}` }
              : {}),
          },
        },
        (response) => {
          const seconds = Number(response.headers["retry-after"]);
          resolve({
            status: response.statusCode || 500,
            ...(Number.isFinite(seconds) && seconds >= 0
              ? { retryAfter: Math.min(seconds, 3600) }
              : {}),
          });
          response.destroy(); // Response bodies can contain secrets; do not read, store or log them.
        },
      );
      req.on("error", () => reject(new AlertTransportError("NETWORK_FAILURE")));
      req.end(body);
    });
  } finally {
    clearTimeout(timeout);
  }
}
