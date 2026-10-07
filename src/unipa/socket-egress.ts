import { connect } from "cloudflare:sockets";
import { createPinnedWebhookFetch } from "./pinned-egress";
import { boundedResponseText } from "./webhook";

// Optional direct Worker adapter. Workers blocks Cloudflare-addressed TCP targets;
// such callbacks require a separate audited egress binding. Never fall back to fetch.
export function socketWebhookFetch(allowedHosts: string[]) {
  return createPinnedWebhookFetch(allowedHosts, {
    async resolveA(hostname, signal) {
      const url = new URL("https://cloudflare-dns.com/dns-query");
      url.searchParams.set("name", hostname);
      url.searchParams.set("type", "A");
      const response = await fetch(url, {
        headers: { Accept: "application/dns-json" },
        redirect: "manual",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("EGRESS_DNS_UNAVAILABLE");
      }
      const reply = JSON.parse(
        await boundedResponseText(response, 16 * 1024),
      ) as { Status?: unknown; Answer?: { type?: unknown; data?: unknown }[] };
      if (reply.Status !== 0 || !Array.isArray(reply.Answer))
        throw new Error("EGRESS_DNS_UNAVAILABLE");
      return reply.Answer.filter((item) => item.type === 1).map((item) => {
        if (typeof item.data !== "string")
          throw new Error("EGRESS_DNS_UNAVAILABLE");
        return item.data;
      });
    },
    async openTls(ip, hostname, signal) {
      const tcp = connect(
        { hostname: ip, port: 443 },
        { secureTransport: "starttls", allowHalfOpen: true },
      );
      const tls = tcp.startTls({ expectedServerHostname: hostname });
      // Suppress only rejected lifecycle promises; exchange errors still propagate.
      void tcp.opened.catch(() => undefined);
      void tcp.closed.catch(() => undefined);
      void tls.closed.catch(() => undefined);
      const abort = () => {
        void tls.close().catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        await tls.opened;
        signal.throwIfAborted();
      } catch {
        signal.removeEventListener("abort", abort);
        await tls.close().catch(() => undefined);
        throw new Error("EGRESS_TLS_UNAVAILABLE");
      }
      return {
        async exchange(bytes, limit, exchangeSignal) {
          const writer = tls.writable.getWriter(),
            reader = tls.readable.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            exchangeSignal.throwIfAborted();
            await writer.write(bytes);
            while (true) {
              exchangeSignal.throwIfAborted();
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > limit) throw new Error("EGRESS_RESPONSE_TOO_LARGE");
              chunks.push(value);
            }
            const joined = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              joined.set(chunk, offset);
              offset += chunk.length;
            }
            return joined;
          } finally {
            writer.releaseLock();
            reader.releaseLock();
          }
        },
        async close() {
          signal.removeEventListener("abort", abort);
          await tls.close().catch(() => undefined);
        },
      };
    },
  });
}
