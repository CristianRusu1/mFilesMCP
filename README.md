# mcp-mfiles

MCP server for exploring M-Files vault metadata structure (object types, classes, properties, value lists) from Claude Desktop chat. Vault-agnostic — no IDs are hardcoded. Everything is discovered live through the M-Files REST API.

## Install

```bash
npm install
npm run build
```

Requires Node 20+.

## Environment variables

Copy `.env.example` to `.env` (only needed for the smoke test) and/or set the same four variables in Claude Desktop config (see below):

```
MFILES_URL=https://your-vault.example.com
MFILES_VAULT_GUID=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
MFILES_USERNAME=your-user@domain
MFILES_PASSWORD=your-password
```

`MFILES_URL` is the **vault base URL only**, without `/REST` or any endpoint path. The vault GUID can be with or without braces — the client normalizes it.

> **Note.** The MCP server itself reads credentials from `process.env`, which Claude Desktop provides via the `env` block in its config. The `.env` file is only read by the standalone smoke-test script (via `dotenv`).

## Tests and sanity checks

Three commands, in order of how much they require:

```bash
npm test          # mocked-fetch unit tests — no vault needed
npm run smoke     # live REST smoke test using .env
npm run smoke:mcp # full MCP protocol flow (auth + find + describe)
```

`npm run smoke` is the best way to verify your credentials before wiring Claude Desktop — if it fails, no amount of MCP debugging will help.

## Claude Desktop configuration

Edit the Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add:

```json
{
  "mcpServers": {
    "mfiles": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-mfiles/dist/index.js"],
      "env": {
        "MFILES_URL": "https://your-vault.example.com",
        "MFILES_VAULT_GUID": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX",
        "MFILES_USERNAME": "your-user@domain",
        "MFILES_PASSWORD": "your-password"
      }
    }
  }
}
```

Restart Claude Desktop. The M-Files tools should appear in the tool menu.

### Enable debug logging

Add a `DEBUG` env var to the same block:

```json
"env": {
  "DEBUG": "mfiles:*",
  "MFILES_URL": "...",
  ...
}
```

Logs go to stderr (Claude Desktop's MCP log pane), never stdout — stdout is reserved for the JSON-RPC protocol channel.

## Tools

### Auth
- `mfiles_authenticate_from_env` — no args. Uses the env vars above.
- `mfiles_authenticate(url, vault_guid, username, password)` — ad-hoc auth for a different vault.
- `mfiles_status(vault_guid?)` — show which vaults are authenticated and when each token expires.

### Atomic introspection
- `mfiles_list_object_types(vault_guid)`
- `mfiles_list_classes(vault_guid, object_type_id?)`
- `mfiles_get_class(vault_guid, class_id)`
- `mfiles_list_properties(vault_guid)`
- `mfiles_get_property(vault_guid, property_id)` — always fetches detail (includes ValueList binding).
- `mfiles_list_value_lists(vault_guid)`
- `mfiles_get_value_list_items(vault_guid, value_list_id)`

### Composite (one-call answers)
- `mfiles_describe_class(vault_guid, class_id, include_value_list_items?)` — class + properties + value list items in one payload.
- `mfiles_describe_object_type(vault_guid, object_type_id, include_properties?)` — object type + its classes + union of properties.

### Search
- `mfiles_find_by_name(vault_guid, name, kind?)` — case-insensitive substring search. `kind` is `object_type | class | property | value_list` or omit for all.

## Example prompts

> "Authenticate from env, then describe the Patient class."
>
> "Find me anything named invoice in my vault."
>
> "What value lists are used by the Customer object type?"

## Usage notes

- Property detail always comes from `/REST/structure/properties/{id}.aspx`. The bulk list endpoint omits `ValueList` bindings in some M-Files versions, which is why `mfiles_get_property` and `mfiles_describe_class` use the detail endpoint per property.
- `mfiles_list_value_lists` filters out entries with `RealObjectType: true` — the underlying `/REST/valuelists.aspx` returns both object types and pure value lists in one payload, and we keep only the latter to match user expectations. Use `mfiles_list_object_types` for the former.
- On a 401 response the token is cleared automatically and tools return `{ error, hint }` telling the LLM to re-authenticate.
- List responses exceeding 200 items are truncated with a hint to use `mfiles_find_by_name`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: keep it vault-agnostic, log to stderr, add tests.

## License

MIT — see [LICENSE](LICENSE).
