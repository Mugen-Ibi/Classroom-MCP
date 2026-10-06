import { CookieJar } from "tough-cookie";
import { UNIPA_ORIGIN, UnipaError } from "./types";

export type Transport = typeof fetch;
export interface Page {
  url: string;
  body: string;
}

export function unipaUrl(path: string, base = `${UNIPA_ORIGIN}/uprx/`): string {
  const url = new URL(path, base);
  if (
    url.origin !== UNIPA_ORIGIN ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/uprx/") ||
    !/\.(?:xhtml)$|\/uprx\/$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new UnipaError("FORMAT_CHANGED");
  return url.href;
}

// The jar and form states live only for this one collection. They are never serialized.
export class UnipaSession {
  private readonly jar = new CookieJar();
  private readonly startedAt = Date.now();
  private requests = 0;
  constructor(
    private readonly signal?: AbortSignal,
    private readonly transport: Transport = (input, init) => fetch(input, init),
  ) {}

  async request(
    path: string,
    fields?: URLSearchParams,
    ajax = false,
  ): Promise<Page> {
    let url = unipaUrl(path);
    let body = fields?.toString();
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (
        ++this.requests > 30 ||
        Date.now() - this.startedAt > 120_000 ||
        this.signal?.aborted
      )
        throw new UnipaError("NETWORK_ERROR");
      const timeout = AbortSignal.timeout(
        Math.min(15_000, 120_000 - (Date.now() - this.startedAt)),
      );
      const signal = this.signal
        ? AbortSignal.any([this.signal, timeout])
        : timeout;
      const headers = new Headers({
        Accept: ajax
          ? "application/xml, text/xml, */*"
          : "text/html,application/xhtml+xml",
        "User-Agent": "Classroom-MCP UNIPA notices/1.0",
      });
      const cookie = await this.jar.getCookieString(url);
      if (cookie) headers.set("Cookie", cookie);
      if (body !== undefined) {
        headers.set(
          "Content-Type",
          "application/x-www-form-urlencoded; charset=UTF-8",
        );
        headers.set("Origin", UNIPA_ORIGIN);
        headers.set("Referer", url);
      }
      if (ajax) {
        headers.set("Faces-Request", "partial/ajax");
        headers.set("X-Requested-With", "XMLHttpRequest");
      }
      try {
        const response = await this.transport(url, {
          method: body === undefined ? "GET" : "POST",
          body,
          headers,
          redirect: "manual",
          signal,
        });
        for (const cookie of response.headers.getSetCookie())
          await this.jar.setCookie(cookie, url, { ignoreError: true });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("Location");
          if (!location) throw new UnipaError("FORMAT_CHANGED");
          // Check BEFORE re-sending any form or Cookie. Never forward to another origin.
          url = unipaUrl(location, url);
          await response.body?.cancel();
          if ([301, 302, 303].includes(response.status)) body = undefined;
          continue;
        }
        if (response.status === 429 || response.status === 503) {
          const value = response.headers.get("Retry-After");
          const delay =
            value && /^\d+$/.test(value)
              ? Number(value)
              : value
                ? (Date.parse(value) - Date.now()) / 1000
                : 300;
          await response.body?.cancel();
          throw new UnipaError(
            "RATE_LIMITED",
            Math.max(300, Number.isFinite(delay) ? Math.ceil(delay) : 300),
          );
        }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new UnipaError("AUTH_REJECTED");
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new UnipaError("NETWORK_ERROR");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new UnipaError("FORMAT_CHANGED");
        const decoder = new TextDecoder();
        let text = "",
          size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 4_000_000) {
              await reader.cancel();
              throw new UnipaError("FORMAT_CHANGED");
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          reader.releaseLock();
        }
        return { url, body: text };
      } catch (error) {
        if (error instanceof UnipaError) throw error;
        throw new UnipaError("NETWORK_ERROR");
      }
    }
    throw new UnipaError("FORMAT_CHANGED");
  }
}
