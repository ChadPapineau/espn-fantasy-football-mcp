// setup-page-browser.test.ts — `eff setup --page` must accept what a real browser sends (plan 03 §2.2:
// accepted only when Origin/Referer match; Stage C finding setup-page-origin-null-refused). A browser
// decides a form POST's `Origin` header from the page's referrer policy (the Fetch standard, "append a
// request `Origin` header": for a non-CORS request whose method is not GET/HEAD, policy `no-referrer`
// serialises the origin as `null`; `same-origin` does so only for a cross-origin target; the
// downgrade-aware policies only for https → http). The test reads the policy the page actually serves
// (header and `<meta>`), derives the headers a browser would send, and posts the form with them: an
// empty submission must reach the value checks (400 "Value refused"), not the Origin refusal (404).
// Under the old `no-referrer` page every real submission was refused. Loopback only; no store, no
// keychain, no ESPN.
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { REFERRER_POLICY, runSetupPage } from "../../src/cli/setup-page.js";
import { fakeExec } from "./helpers.js";

/** The `Origin` header a browser sends on a form POST (Fetch standard §3.1; the request is not CORS). */
function browserPostOrigin(policy: string, pageOrigin: string, target: string): string {
  const page = new URL(pageOrigin);
  const to = new URL(target);
  switch (policy) {
    case "no-referrer":
      return "null";
    case "no-referrer-when-downgrade":
    case "strict-origin":
    case "strict-origin-when-cross-origin":
    case "":
      return page.protocol === "https:" && to.protocol !== "https:" ? "null" : page.origin;
    case "same-origin":
      return page.origin === to.origin ? page.origin : "null";
    default:
      return page.origin;
  }
}

/** The `Referer` a browser sends on that POST (null when the policy sends none). */
function browserPostReferer(policy: string, pageUrl: string, target: string): string | null {
  const page = new URL(pageUrl);
  const to = new URL(target);
  const sameOrigin = page.origin === to.origin;
  switch (policy) {
    case "no-referrer":
      return null;
    case "same-origin":
      return sameOrigin ? page.href : null;
    case "origin":
      return `${page.origin}/`;
    case "strict-origin":
      return page.protocol === "https:" && to.protocol !== "https:" ? null : `${page.origin}/`;
    default:
      return sameOrigin ? page.href : `${page.origin}/`;
  }
}

/** The policy a page applies: its `<meta name="referrer">` wins over the response header. */
function effectivePolicy(header: string | null, html: string): string {
  const m = /<meta name="referrer" content="([^"]*)">/.exec(html);
  return (m?.[1] ?? header ?? "").trim().toLowerCase();
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => {
        resolve(typeof a === "object" && a !== null ? a.port : 0);
      });
    });
  });
}

let stop: AbortController | null = null;
afterEach(() => {
  stop?.abort();
  stop = null;
});

async function openPage(): Promise<{ url: string; port: number; run: Promise<unknown> }> {
  const port = await freePort();
  stop = new AbortController();
  let url = "";
  const run = runSetupPage({
    explicitPort: port,
    exec: fakeExec().exec,
    out: () => undefined,
    signal: stop.signal,
    onListening: (u) => {
      url = u;
    },
  });
  while (url === "") await new Promise((r) => setTimeout(r, 5));
  return { url, port, run };
}

// loopback only: the page under test, on 127.0.0.1
const loopback = globalThis.fetch as (u: string, i?: RequestInit) => Promise<Response>;

describe("the setup page accepts a real browser's form POST", () => {
  it("serves a referrer policy under which a same-page POST carries the page's Origin", async () => {
    const { url } = await openPage();
    const page = await loopback(url);
    const html = await page.text();
    const policy = effectivePolicy(page.headers.get("referrer-policy"), html);
    expect(policy).toBe(REFERRER_POLICY);
    expect(page.headers.get("referrer-policy")).toBe(REFERRER_POLICY);
    const pageOrigin = new URL(url).origin;
    expect(browserPostOrigin(policy, pageOrigin, url)).toBe(pageOrigin);
    // and the token-bearing URL is never sent to another origin
    expect(browserPostReferer(policy, url, "http://other.example/")).toBeNull();
  });

  it("the browser's empty submission reaches the value checks (400), not the Origin refusal (404)", async () => {
    const { url } = await openPage();
    const page = await loopback(url);
    const html = await page.text();
    const policy = effectivePolicy(page.headers.get("referrer-policy"), html);
    const token = /name="token" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
    const action = new URL(/action="([^"]+)"/.exec(html)?.[1] ?? "", url).href;
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      origin: browserPostOrigin(policy, new URL(url).origin, action),
    };
    const referer = browserPostReferer(policy, url, action);
    if (referer !== null) headers.referer = referer;
    const r = await loopback(action, {
      method: "POST",
      headers,
      body: new URLSearchParams({ token, swid: "", espn_s2: "" }).toString(),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("<form");
  });

  it("a POST from another origin is still refused (404)", async () => {
    const { url } = await openPage();
    const html = await (await loopback(url)).text();
    const token = /name="token" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
    const r = await loopback(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: browserPostOrigin(REFERRER_POLICY, "http://evil.example", url),
      },
      body: new URLSearchParams({ token, swid: "", espn_s2: "" }).toString(),
    });
    expect(r.status).toBe(404);
  });

  it("the Fetch model: no-referrer always serialises null (why the old page refused everything)", () => {
    const o = "http://127.0.0.1:8790";
    expect(browserPostOrigin("no-referrer", o, `${o}/setup/x`)).toBe("null");
    expect(browserPostOrigin("same-origin", o, `${o}/setup/x`)).toBe(o);
    expect(browserPostOrigin("same-origin", "http://evil.example", `${o}/setup/x`)).toBe("null");
    expect(browserPostOrigin("strict-origin-when-cross-origin", o, `${o}/x`)).toBe(o);
    expect(browserPostOrigin("strict-origin", "https://a.example", `${o}/x`)).toBe("null");
    expect(browserPostReferer("same-origin", `${o}/setup/x`, `${o}/setup/x`)).toBe(`${o}/setup/x`);
    expect(browserPostReferer("no-referrer", `${o}/setup/x`, `${o}/setup/x`)).toBeNull();
  });
});
