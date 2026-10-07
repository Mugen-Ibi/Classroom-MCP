import { validateCallbackUrl, type VerifiedWebhookFetch } from "./webhook";

export interface PinnedChannel {
  exchange(
    bytes: Uint8Array,
    limit: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface PinnedEgressDependencies {
  resolveA(hostname: string, signal: AbortSignal): Promise<string[]>;
  // Implementations MUST connect to this exact IP and verify TLS against hostname.
  openTls(
    ip: string,
    hostname: string,
    signal: AbortSignal,
  ): Promise<PinnedChannel>;
}

// Conservative IPv4-only public route policy. IPv6-only destinations fail closed.
export function publicIPv4(value: string): boolean {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((v) => !/^(0|[1-9]\d{0,2})$/.test(v) || Number(v) > 255)
  )
    return false;
  const [a, b, c] = parts.map(Number) as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function responseFromWire(bytes: Uint8Array): Response {
  // Verification is tiny. Refuse compressed/ambiguous framing and oversized responses.
  const wire = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const boundary = wire.indexOf("\r\n\r\n");
  if (boundary < 0 || boundary > 8192)
    throw new Error("EGRESS_RESPONSE_INVALID");
  const lines = wire.slice(0, boundary).split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] ([2-5]\d\d)(?: [^\r\n]*)?$/.exec(
    lines.shift() ?? "",
  );
  if (!statusMatch) throw new Error("EGRESS_RESPONSE_INVALID");
  const status = Number(statusMatch[1]);
  if (status >= 300 && status < 400)
    throw new Error("EGRESS_REDIRECT_REJECTED");
  const headers = new Headers();
  for (const line of lines) {
    const match = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!match || headers.has(match[1]!))
      throw new Error("EGRESS_RESPONSE_INVALID");
    headers.set(match[1]!, match[2]!);
  }
  if (headers.has("content-encoding"))
    throw new Error("EGRESS_RESPONSE_INVALID");
  let body = wire.slice(boundary + 4);
  const transfer = headers.get("transfer-encoding"),
    length = headers.get("content-length");
  if (transfer && length) throw new Error("EGRESS_RESPONSE_INVALID");
  if (transfer) {
    if (transfer.toLowerCase() !== "chunked")
      throw new Error("EGRESS_RESPONSE_INVALID");
    let decoded = "";
    while (true) {
      const end = body.indexOf("\r\n");
      if (end < 0 || !/^[a-fA-F0-9]{1,4}$/.test(body.slice(0, end)))
        throw new Error("EGRESS_RESPONSE_INVALID");
      const size = parseInt(body.slice(0, end), 16);
      body = body.slice(end + 2);
      // UTF-8 byte framing: decode each chunk only after its exact byte boundary.
      const encoded = new TextEncoder().encode(body);
      if (size === 0) {
        if (body !== "\r\n") throw new Error("EGRESS_RESPONSE_INVALID");
        break;
      }
      if (
        encoded.length < size + 2 ||
        encoded[size] !== 13 ||
        encoded[size + 1] !== 10
      )
        throw new Error("EGRESS_RESPONSE_INVALID");
      decoded += new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(encoded.slice(0, size));
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        encoded.slice(size + 2),
      );
    }
    body = decoded;
  } else if (
    length &&
    (!/^\d{1,5}$/.test(length) ||
      Number(length) !== new TextEncoder().encode(body).length)
  )
    throw new Error("EGRESS_RESPONSE_INVALID");
  if (new TextEncoder().encode(body).length > 4096)
    throw new Error("EGRESS_RESPONSE_TOO_LARGE");
  headers.delete("transfer-encoding");
  headers.delete("content-length");
  return new Response(
    status === 204 || status === 205 || status === 304 ? null : body,
    { status, headers },
  );
}

export function createPinnedWebhookFetch(
  allowedHosts: string[],
  dependencies: PinnedEgressDependencies,
): VerifiedWebhookFetch {
  return async (raw, init) => {
    const url = new URL(validateCallbackUrl(raw, allowedHosts));
    if (
      init.method !== "POST" ||
      init.redirect !== "error" ||
      typeof init.body !== "string"
    )
      throw new Error("EGRESS_REQUEST_INVALID");
    const signal = init.signal ?? AbortSignal.timeout(10_000);
    signal.throwIfAborted();
    const addresses = await dependencies.resolveA(url.hostname, signal);
    if (
      !addresses.length ||
      addresses.length > 16 ||
      addresses.some((ip) => !publicIPv4(ip))
    )
      throw new Error("EGRESS_ADDRESS_REJECTED");
    const headers = new Headers(init.headers);
    const allowedHeaders = new Set([
      "content-type",
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
      "x-mcp-subscription-id",
    ]);
    for (const name of headers.keys())
      if (!allowedHeaders.has(name)) throw new Error("EGRESS_HEADER_REJECTED");
    const body = new TextEncoder().encode(init.body);
    if (body.length > 256 * 1024) throw new Error("EGRESS_REQUEST_TOO_LARGE");
    const headerLines = [
      `POST ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.hostname}`,
      "Connection: close",
      "Accept-Encoding: identity",
      `Content-Length: ${body.length}`,
    ];
    headers.forEach((value, name) => headerLines.push(`${name}: ${value}`));
    const prefix = new TextEncoder().encode(
      headerLines.join("\r\n") + "\r\n\r\n",
    );
    const bytes = new Uint8Array(prefix.length + body.length);
    bytes.set(prefix);
    bytes.set(body, prefix.length);
    let channel: PinnedChannel | undefined;
    try {
      channel = await dependencies.openTls(addresses[0]!, url.hostname, signal);
      return responseFromWire(await channel.exchange(bytes, 16 * 1024, signal));
    } finally {
      await channel?.close();
    }
  };
}
