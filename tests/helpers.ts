import { MFilesClient } from "../src/mfiles-client.js";

/**
 * A fetch mock that answers by route instead of by call order, and records
 * every request with its logical method (PUT/DELETE tunnelled through POST
 * via ?_method= are reported as PUT/DELETE).
 */
export interface Route {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** A string matches the URL pathname exactly; a RegExp is tested against pathname + query. */
  path: string | RegExp;
  status?: number;
  json?: unknown;
  text?: string;
  /** Remove the route after it answers once. */
  once?: boolean;
}

export interface RecordedCall {
  /** Logical method, i.e. the ?_method= override when present. */
  method: string;
  /** Pathname + query, without the _method parameter. */
  path: string;
  /** What actually went over the wire. */
  httpMethod: string;
  rawUrl: string;
  body?: string;
  headers: Record<string, string>;
}

function fakeResponse(status: number, json: unknown, text?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : String(status),
    json: async () => json ?? {},
    text: async () => text ?? (json !== undefined ? JSON.stringify(json) : ""),
  } as Response;
}

export function routeFetch(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const pending = [...routes];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const rawUrl = String(input);
    const url = new URL(rawUrl);
    const httpMethod = init?.method ?? "GET";
    const method = url.searchParams.get("_method") ?? httpMethod;
    url.searchParams.delete("_method");
    const pathAndQuery = url.pathname + url.search;
    calls.push({
      method,
      path: pathAndQuery,
      httpMethod,
      rawUrl,
      body: init?.body as string | undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const index = pending.findIndex(
      (r) =>
        (r.method ?? "GET") === method &&
        (typeof r.path === "string"
          ? url.pathname === r.path
          : r.path.test(pathAndQuery)),
    );
    if (index < 0) {
      return fakeResponse(500, undefined, `no mock route for ${method} ${pathAndQuery}`);
    }
    const route = pending[index];
    if (route.once) pending.splice(index, 1);
    return fakeResponse(route.status ?? 200, route.json, route.text);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** An authenticated client whose recorded calls start after authentication. */
export async function connect(routes: Route[]) {
  const mock = routeFetch([
    {
      method: "POST",
      path: "/REST/server/authenticationtokens.aspx",
      json: { Value: "tok" },
    },
    ...routes,
  ]);
  const client = new MFilesClient("https://vault.example.com");
  await client.authenticate("g", "u", "p");
  mock.calls.length = 0;
  return { client, ...mock };
}

/** "GET /REST/..." lines, handy for asserting call order. */
export function callLines(calls: RecordedCall[]): string[] {
  return calls.map((c) => `${c.method} ${c.path}`);
}
