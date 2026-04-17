# M-Files MCP Server for Claude Desktop

## Goal

Build an MCP server that lets you explore any M-Files vault's metadata structure through Claude Desktop chat — faster than navigating the M-Files Admin UI manually. Point it at a vault, authenticate, and ask questions like "describe the Patient class" or "what value lists are used by the Invoice object type." The server returns complete, structured answers in one call instead of requiring you to click through Metadata Structure → Classes → Properties → Value Lists tabs one at a time.

The server is **vault-agnostic**: it never assumes or hardcodes IDs, because object type, class, property, and value list IDs are assigned per vault. Everything is discovered live through the M-Files REST API.

Claude Desktop handles the chat UI, image attachments, and PDF attachments natively — no custom frontend or API bridge needed.

## Architecture

Single TypeScript package, stdio MCP transport:

```
mcp-mfiles/
├── src/
│   ├── index.ts              # MCP server entry (stdio)
│   ├── mfiles-client.ts      # Thin REST wrapper
│   ├── session.ts            # In-memory session/token storage
│   ├── tools/
│   │   ├── auth.ts           # authenticate, authenticate_from_env, status
│   │   ├── structure.ts      # atomic list/get tools
│   │   ├── composite.ts      # describe_class, describe_object_type
│   │   └── search.ts         # find_by_name
│   └── types.ts              # M-Files REST response types + DataType enum
├── scripts/
│   └── smoke.ts              # Standalone REST smoke test
├── dist/                     # Compiled output
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

**Stack.** TypeScript, `@modelcontextprotocol/sdk`, native `fetch` (Node 20+), `zod` for tool input schemas. No database, no Express, no frontend.

## Phase 1 — Project scaffold

`npm init`, TypeScript config targeting Node 20+, ESM output. Install `@modelcontextprotocol/sdk`, `zod`, and dev deps (`typescript`, `tsx`, `@types/node`). Add `build`, `dev`, and `smoke` scripts. Write `CLAUDE.md` with the vault-agnostic guidance (see bottom of this doc). 

**Deliverable:** empty MCP server starts, Claude Desktop can connect and show zero tools.

## Phase 2 — M-Files REST client

Build `mfiles-client.ts`: a class that takes a base URL and manages the `X-Authentication` header. Methods map 1:1 to the endpoints needed:

- `authenticate(vaultGuid, username, password)`
- `listObjectTypes()`, `listClasses(objectTypeId?)`, `getClass(classId)`
- `listProperties()`, `getProperty(propertyId)` — detail endpoint only
- `listValueLists()`, `getValueListItems(valueListId)`

Always fetch property details from `structure/properties/{id}.aspx` — the bulk `structure/properties.aspx` response omits `ValueList` bindings in some versions.

Handle 401s by clearing the cached token and returning a structured error that tells the LLM to re-authenticate.

**Deliverable:** `scripts/smoke.ts` authenticates and lists classes against a real vault.

## Phase 3 — Session storage

`session.ts` holds an in-memory `Map<vaultGuid, { token, url, expiresAt }>`. Every non-auth tool accepts a `vault_guid` argument and looks up the token. If missing or expired, return a structured error instructing the LLM to call `mfiles_authenticate` first. No persistence needed — session lifetime matches the Claude Desktop session.

**Credential handling.** Since there's no API bridge, the LLM will see credentials if typed into chat. Ship both options:

- **Env var option (recommended):** read `MFILES_URL`, `MFILES_VAULT_GUID`, `MFILES_USERNAME`, `MFILES_PASSWORD` from environment. Expose `mfiles_authenticate_from_env()` with no arguments. Set these once in the Claude Desktop config.
- **Inline option:** `mfiles_authenticate(url, vault_guid, username, password)` for ad-hoc connections to other vaults.

## Phase 4 — Atomic introspection tools

Implement as MCP tools with Zod schemas:

- `mfiles_authenticate_from_env` — no args
- `mfiles_authenticate(url, vault_guid, username, password)`
- `mfiles_status(vault_guid?)` — reports which vaults are authenticated and token expiry
- `mfiles_list_object_types(vault_guid)`
- `mfiles_list_classes(vault_guid, object_type_id?)`
- `mfiles_get_class(vault_guid, class_id)`
- `mfiles_list_properties(vault_guid)`
- `mfiles_get_property(vault_guid, property_id)` — always hits the detail endpoint
- `mfiles_list_value_lists(vault_guid)`
- `mfiles_get_value_list_items(vault_guid, value_list_id)`

Return results as stringified JSON in a `text` content block. Include short `_hint` fields when useful (e.g., "This property is bound to value list 1037 — use `mfiles_get_value_list_items` to retrieve allowed values"). Include a resolved `DataTypeName` alongside the raw `DataType` integer so the LLM doesn't have to memorize the enum.

**Deliverable:** load in Claude Desktop, ask "list all object types in my vault," verify it works.

## Phase 5 — Composite and search tools

The value-multiplier tools. These exist to turn a 10-tool-call question into a 1-tool-call question.

- `mfiles_describe_class(vault_guid, class_id, include_value_list_items=true)` — returns the class definition, all associated properties with data types and value list IDs, and the value list items themselves when the flag is set. One call replaces: `get_class` + N × `get_property` + M × `get_value_list_items`.
- `mfiles_describe_object_type(vault_guid, object_type_id, include_properties=true)` — returns the object type, its classes, and optionally the union of properties across those classes.
- `mfiles_find_by_name(vault_guid, name, kind?)` — filters structure list endpoints by name. `kind` is one of `"object_type" | "class" | "property" | "value_list"` or omitted for all. Case-insensitive substring match. Replaces clicking through the admin UI hunting for "the class called Patient."

**Deliverable:** "describe the Patient class" in Claude Desktop returns a complete tree in a single tool call; "find me anything named invoice" returns hits across all structure kinds.

## Phase 6 — Error handling and UX polish

- Every tool wraps errors into `{ error: string, hint: string }`. LLMs recover much better from "Token expired, call `mfiles_authenticate_from_env`" than from raw HTTP 401s.
- Log to stderr only with a `DEBUG=mfiles:*` prefix (stdout is reserved for the JSON-RPC channel). Enable in Claude Desktop config when debugging.
- Set reasonable response size guards — if a bulk list returns thousands of items, truncate with a note telling the LLM to filter via `find_by_name` instead.

## Phase 7 — Claude Desktop integration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS (`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "mfiles": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-mfiles/dist/index.js"],
      "env": {
        "MFILES_URL": "https://your-vault.cloudvault.m-files.com",
        "MFILES_VAULT_GUID": "{...}",
        "MFILES_USERNAME": "...",
        "MFILES_PASSWORD": "..."
      }
    }
  }
}
```

Document both paths in the README along with how to temporarily enable debug logging.

**Deliverable:** restart Claude Desktop, see the M-Files tools in the tool menu, ask Claude to describe the vault structure.

## Phase 8 — Optional extensions

Add only if they earn their keep:

- **Object read tools:** `mfiles_search_objects(vault_guid, object_type_id, filters?)`, `mfiles_get_object(vault_guid, object_type_id, object_id)` — useful for debugging integrations ("show me patient object 12345's current property values").
- **Workflow introspection:** `mfiles_list_workflows`, `mfiles_get_workflow` with states and transitions.
- **Write tools** (create/update objects) — gated behind `MFILES_ALLOW_WRITES=true` env flag so chat can't accidentally mutate production.

---

## CLAUDE.md — notes for Claude Code while building

Drop this into `CLAUDE.md` at the repo root so Claude Code has the right context every session.

### Product intent

- This MCP is a **vault structure explorer**. The goal is to surface object types, classes, properties, value lists, and their relationships faster than the M-Files Admin UI does.
- The server must work against **any** vault. Nothing is vault-specific.

### Hard rules

- **Never hardcode object type, class, property, or value list IDs.** They are assigned per vault and differ across environments. All IDs come from live introspection calls.
- **Log to stderr only.** Stdout is reserved for the MCP JSON-RPC channel. Using `console.log` will corrupt the protocol.
- **ESM, Node 20+, `StdioServerTransport`.**
- **Validate every tool input with Zod.** Output is always stringified JSON inside a text content block.

### Real vault-agnostic M-Files REST quirks

- Always fetch property details from `structure/properties/{id}.aspx`. The bulk `structure/properties.aspx` response omits `ValueList` bindings in some versions.
- `X-Authentication` header carries the session token. A 401 means the token expired — clear the cached session and surface an error telling the LLM to re-authenticate.
- REST date fields are ISO 8601 on the wire regardless of how the M-Files client UI displays them. Display format is a per-vault/per-user setting and not something this MCP cares about.
- `DataType` on a property definition is an integer enum. Common values: `1=Text`, `2=Integer`, `3=Real`, `5=Date`, `7=Boolean`, `8=SingleSelectLookup`, `9=MultiSelectLookup`, `10=Text (multi-line)`, `13=FloatingPoint`. Include a resolved `DataTypeName` in responses.

### Design principles

- **Composite over chained.** When the LLM asks a high-level question ("describe the Patient class"), a composite tool should answer it in one call. Don't force the LLM to chain 10 atomic calls.
- **Errors should teach the LLM what to do next.** Return `{ error, hint }` pairs. Example hint: "Token expired — call `mfiles_authenticate_from_env` first."
- **Truncate and redirect on huge responses.** If a bulk list is massive, truncate and point the LLM at `mfiles_find_by_name` or a more specific endpoint.