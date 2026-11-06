import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MFilesClient, extractErrorMessage } from "../src/mfiles-client.js";
import { MFilesAuthError, MFilesRequestError } from "../src/types.js";
import { connect } from "./helpers.js";

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function mockFetch(
  responses: Array<{
    status?: number;
    ok?: boolean;
    json?: unknown;
    text?: string;
  }>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[i++] ?? { status: 500 };
    return {
      ok: r.ok ?? (r.status === undefined || (r.status >= 200 && r.status < 300)),
      status: r.status ?? 200,
      statusText: r.status === 401 ? "Unauthorized" : "OK",
      json: async () => r.json ?? {},
      text: async () => r.text ?? "",
    } as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("MFilesClient.authenticate", () => {
  let mock: ReturnType<typeof mockFetch>;
  afterEach(() => mock?.restore());

  it("sends username/password/braced VaultGuid to the auth endpoint", async () => {
    mock = mockFetch([
      { json: { Value: "token-abc", Expiration: "2099-01-01T00:00:00Z" } },
    ]);
    const client = new MFilesClient("https://vault.example.com");
    const session = await client.authenticate(
      "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      "user@example.com",
      "pw",
    );
    assert.equal(mock.calls.length, 1);
    assert.equal(
      mock.calls[0].url,
      "https://vault.example.com/REST/server/authenticationtokens.aspx",
    );
    assert.equal(mock.calls[0].init?.method, "POST");
    const body = JSON.parse(mock.calls[0].init?.body as string);
    assert.equal(body.Username, "user@example.com");
    assert.equal(body.Password, "pw");
    assert.equal(body.VaultGuid, "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}");
    assert.equal(session.token, "token-abc");
    assert.equal(session.expiresAt.getFullYear(), 2099);
  });

  it("accepts a GUID that already has braces", async () => {
    mock = mockFetch([{ json: { Value: "t" } }]);
    const client = new MFilesClient("https://vault.example.com");
    await client.authenticate("{11111111-2222-3333-4444-555555555555}", "u", "p");
    const body = JSON.parse(mock.calls[0].init?.body as string);
    assert.equal(body.VaultGuid, "{11111111-2222-3333-4444-555555555555}");
  });

  it("throws MFilesAuthError on a failed auth request", async () => {
    mock = mockFetch([{ status: 401, text: "Invalid credentials" }]);
    const client = new MFilesClient("https://vault.example.com");
    await assert.rejects(
      () => client.authenticate("g", "u", "p"),
      (err: unknown) => err instanceof MFilesAuthError,
    );
  });

  it("defaults to an 8h expiry when the server omits Expiration", async () => {
    mock = mockFetch([{ json: { Value: "token" } }]);
    const client = new MFilesClient("https://vault.example.com");
    const before = Date.now();
    const session = await client.authenticate("g", "u", "p");
    const after = Date.now();
    const diff = session.expiresAt.getTime() - before;
    assert.ok(diff >= 7 * 60 * 60 * 1000);
    assert.ok(diff <= 9 * 60 * 60 * 1000 + (after - before));
  });
});

describe("MFilesClient.request (via list/get methods)", () => {
  let mock: ReturnType<typeof mockFetch>;
  afterEach(() => mock?.restore());

  it("sends the X-Authentication header on every non-auth call", async () => {
    mock = mockFetch([
      { json: { Value: "tok-123" } },
      { json: [{ ID: 1, Name: "Document" }] },
    ]);
    const client = new MFilesClient("https://vault.example.com");
    await client.authenticate("g", "u", "p");
    await client.listObjectTypes();
    const authHeader = (mock.calls[1].init?.headers as Record<string, string>)[
      "X-Authentication"
    ];
    assert.equal(authHeader, "tok-123");
  });

  it("on 401 clears the token and throws MFilesAuthError", async () => {
    mock = mockFetch([
      { json: { Value: "tok" } },
      { status: 401, text: "expired" },
    ]);
    const client = new MFilesClient("https://vault.example.com");
    await client.authenticate("g", "u", "p");
    assert.equal(client.hasToken(), true);
    await assert.rejects(
      () => client.listObjectTypes(),
      (err: unknown) => err instanceof MFilesAuthError,
    );
    assert.equal(client.hasToken(), false);
  });

  it("on other non-2xx wraps the error in MFilesRequestError with status", async () => {
    mock = mockFetch([
      { json: { Value: "tok" } },
      { status: 404, text: "not found" },
    ]);
    const client = new MFilesClient("https://vault.example.com");
    await client.authenticate("g", "u", "p");
    await assert.rejects(
      () => client.getClass(999),
      (err: unknown) => err instanceof MFilesRequestError && (err as MFilesRequestError).status === 404,
    );
  });

  it("getProperty uses the detail endpoint (structure/properties/{id}.aspx)", async () => {
    mock = mockFetch([
      { json: { Value: "tok" } },
      { json: { ID: 1090, Name: "Adverse Event Name", DataType: 1 } },
    ]);
    const client = new MFilesClient("https://vault.example.com");
    await client.authenticate("g", "u", "p");
    await client.getProperty(1090);
    assert.equal(
      mock.calls[1].url,
      "https://vault.example.com/REST/structure/properties/1090.aspx",
    );
  });

  it("listValueLists filters out entries with RealObjectType=true", async () => {
    mock = mockFetch([
      { json: { Value: "tok" } },
      {
        json: [
          { ID: 0, Name: "Document", RealObjectType: true },
          { ID: 104, Name: "Patient", RealObjectType: true },
          { ID: 120, Name: "Patient Response", RealObjectType: false },
          { ID: 116, Name: "Adverse Event Type" }, // missing flag → treated as not a real object type
        ],
      },
    ]);
    const client = new MFilesClient("https://vault.example.com");
    await client.authenticate("g", "u", "p");
    const result = await client.listValueLists();
    const names = result.map((v) => v.Name);
    assert.deepEqual(names, ["Patient Response", "Adverse Event Type"]);
  });

  it("listClasses filters client-side when given an object_type_id", async () => {
    mock = mockFetch([
      { json: { Value: "tok" } },
      {
        json: [
          { ID: 1, Name: "Foo", ObjectType: 0 },
          { ID: 2, Name: "Bar", ObjectType: 104 },
          { ID: 3, Name: "Baz", ObjectType: 104 },
        ],
      },
    ]);
    const client = new MFilesClient("https://vault.example.com");
    await client.authenticate("g", "u", "p");
    const result = await client.listClasses(104);
    assert.deepEqual(result.map((c) => c.ID), [2, 3]);
  });
});

describe("MFilesClient writes", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("tunnels PUT through POST with ?_method=PUT and a JSON body", async () => {
    const mock = await connect([
      {
        method: "PUT",
        path: "/REST/objects/0/42/latest/checkedout.aspx",
        json: { ObjVer: { ID: 42, Type: 0, Version: 6 } },
      },
    ]);
    restore = mock.restore;
    const ov = await mock.client.checkOut(0, 42);
    assert.equal(ov.ObjVer.Version, 6);
    assert.equal(mock.calls[0].httpMethod, "POST");
    assert.equal(
      mock.calls[0].rawUrl,
      "https://vault.example.com/REST/objects/0/42/latest/checkedout.aspx?_method=PUT",
    );
    assert.equal(mock.calls[0].headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(mock.calls[0].body!), { Value: 2 });
  });

  it("tunnels DELETE and resolves 204 No Content without parsing a body", async () => {
    const mock = await connect([
      { method: "DELETE", path: "/REST/objects/0/42/6.aspx", status: 204 },
    ]);
    restore = mock.restore;
    await mock.client.undoCheckout(0, 42, 6);
    assert.equal(mock.calls[0].httpMethod, "POST");
    assert.equal(
      mock.calls[0].rawUrl,
      "https://vault.example.com/REST/objects/0/42/6.aspx?_method=DELETE",
    );
  });

  it("surfaces the Message of an MFWS error body", async () => {
    const mock = await connect([
      {
        method: "POST",
        path: "/REST/objects/0/42/6/properties.aspx",
        status: 500,
        text: JSON.stringify({
          Status: 500,
          Message: "The object is checked out to another user.",
          Exception: { Name: "COMException", Message: "inner" },
        }),
      },
    ]);
    restore = mock.restore;
    await assert.rejects(
      () => mock.client.setProperties(0, 42, 6, []),
      (err: unknown) =>
        err instanceof MFilesRequestError &&
        err.status === 500 &&
        err.serverMessage === "The object is checked out to another user." &&
        err.message.endsWith("The object is checked out to another user."),
    );
  });

  it("URL-encodes value list filters", async () => {
    const mock = await connect([
      { path: /^\/REST\/valuelists\/5\/items\.aspx\?filter=/, json: { Items: [] } },
    ]);
    restore = mock.restore;
    await mock.client.findValueListItems(5, "R&D / Lab");
    assert.equal(
      mock.calls[0].rawUrl,
      "https://vault.example.com/REST/valuelists/5/items.aspx?filter=R%26D%20%2F%20Lab",
    );
  });

  it("sends extension method input as text/plain and returns the raw output", async () => {
    const mock = await connect([
      { method: "POST", path: "/REST/vault/extensionmethod/My_Method.aspx", text: "{\"ok\":true}" },
    ]);
    restore = mock.restore;
    const out = await mock.client.executeExtensionMethod("My_Method", "{\"a\":1}");
    assert.equal(out, "{\"ok\":true}");
    assert.equal(mock.calls[0].headers["Content-Type"], "text/plain; charset=utf-8");
    assert.equal(mock.calls[0].body, "{\"a\":1}");
  });
});

describe("extractErrorMessage", () => {
  it("prefers the top-level Message, then Exception.Message", () => {
    assert.equal(extractErrorMessage(JSON.stringify({ Message: " top " })), "top");
    assert.equal(
      extractErrorMessage(JSON.stringify({ Exception: { Message: "inner" } })),
      "inner",
    );
  });

  it("returns undefined for non-JSON or message-less bodies", () => {
    assert.equal(extractErrorMessage("<html>"), undefined);
    assert.equal(extractErrorMessage(JSON.stringify({ Status: 500 })), undefined);
  });
});
