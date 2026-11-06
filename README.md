# mcp-mfiles

MCP server for exploring M-Files vault metadata structure (object types, classes, properties, value lists) from Claude Desktop chat. Vault-agnostic — no IDs are hardcoded. Everything is discovered live through the M-Files REST API.

Optionally, it can also **write**: set property values on objects, create objects and value list items, and, with the companion [vault app](vault-app/README.md), create property definitions and value lists and add properties to classes. Writes are off unless you set `MFILES_ALLOW_WRITES=true` (see [Write tools](#write-tools)).

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

Optional:

```
MFILES_ALLOW_WRITES=true   # register the write tools (default: off, read-only)
```

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

## Write tools

Write tools are registered only when the server's environment has `MFILES_ALLOW_WRITES=true`. Without it the server is exactly the read-only explorer described above, and `mfiles_status` reports `writes_enabled: false`. The flag applies to every vault that server process authenticates to, so leave it off on server entries that point at production unless you mean it.

Every write tool takes `dry_run: true`. A dry run resolves names, validates values against the live structure and shows what would change, without writing anything. The tools carry MCP annotations (`readOnlyHint` / `destructiveHint`), so clients can tell them apart from the read tools.

### Objects (REST API, no vault app needed)
- `mfiles_get_object(vault_guid, object_type_id, object_id, version?)` — title, class, checkout state and every property value with names and data types.
- `mfiles_update_object_properties(vault_guid, object_type_id, object_id, set?, remove?, dry_run?)` — set, clear or remove property values. This is also how you add a property the class doesn't define. The tool checks the object out, applies every change, then checks it back in. If anything fails, it undoes the checkout, so nothing is half-saved. Objects checked out to someone else are left alone.
- `mfiles_create_object(vault_guid, object_type_id, class_id, properties?, dry_run?)` — create an object without files. A dry run lists required class properties you haven't supplied.
- `mfiles_create_value_list_item(vault_guid, value_list_id, name, owner_item_id?, parent_item_id?, allow_duplicate?, dry_run?)` — add an item to a plain value list. If an item with that name already exists, the tool returns it instead of creating a duplicate.

Properties can be given by ID (number) or exact name (string). Values follow the property's live data type:

| Data type | Value |
|---|---|
| Text, MultiLineText | string |
| Integer, Floating | number |
| Date | `"YYYY-MM-DD"` |
| Time | `"HH:MM"` or `"HH:MM:SS"` |
| Timestamp | ISO 8601, e.g. `"2024-05-31T14:30:00Z"` |
| Boolean | `true` / `false` |
| SingleSelectLookup | item ID (number) or exact item name (string) |
| MultiSelectLookup | array of IDs/names; replaces the selection unless `append: true` |
| any | `null` clears the value |

### Metadata structure (needs the [vault app](vault-app/README.md))
The M-Files REST API can't change metadata structure, and doesn't show scripts or event handlers at all. These tools call extension methods in the MFilesMCP vault app instead. They need it installed in the vault, and an account with the `Change metadata structure` right.

The app runs each change as a job. A tool waits up to 45 seconds for it (`MFILES_STRUCTURE_WAIT_SECONDS`); if the job is still running, the tool returns a `job_id` to check later with `mfiles_structure_job`, and the change carries on in the vault.

Status and reads:
- `mfiles_structure_app_status(vault_guid, verify_class_id?)` — is the app installed, compatible, and able to open its admin session?
- `mfiles_structure_job(vault_guid, job_id)` — result of a job that outlived its tool call.
- `mfiles_get_admin_definition(vault_guid, kind, id)` — a class or property definition as M-Files Admin sees it: aliases, calculated value or automatic numbering, validation.
- `mfiles_get_workflow(vault_guid, workflow)` — states with their scripts and actions, transitions with their triggers and trigger scripts.
- `mfiles_list_event_handlers(vault_guid, event_type?, name?, include_scripts?)` — the vault's VBScript event handlers, including vault extension methods.

Changes:
- `mfiles_create_property_def(vault_guid, name, data_type, value_list_id?, defined_for_object_type_id?, all_object_types?, aliases?, add_to_classes?, allow_duplicate_name?, dry_run?)` — create a property definition and optionally add it to classes in the same call. When you pass `add_to_classes`, the "defined for" object type is inferred from those classes.
- `mfiles_update_property_def(vault_guid, property, rename?, add_aliases?, remove_aliases?, automatic_value?, validation?, recalculate?, dry_run?)` — rename, aliases, calculated values (placeholders or VBScript), automatic numbering, regex or VBScript validation.
- `mfiles_create_object_type(vault_guid, name_singular, name_plural?, can_have_files?, allow_adding?, owner_object_type_id?, aliases?, dry_run?)` — a new kind of object, like Customer or Project. M-Files also adds a property definition that refers to it, and usually a class of the same name. Needs vault app 1.0.11.
- `mfiles_create_class(vault_guid, object_type_id, name, name_property?, properties?, workflow?, force_workflow?, aliases?, dry_run?)`
- `mfiles_update_class(vault_guid, class_id, add?, remove?, rename?, workflow?, force_workflow?, name_property?, dry_run?)` — add or remove properties, change required flags, rename, set or remove (`workflow: null`) the workflow, change the name property.
- `mfiles_create_value_list(vault_guid, name_singular, name_plural?, items?, aliases?, allow_duplicate_name?, dry_run?)` — create a value list with initial items.
- `mfiles_create_workflow(vault_guid, name, states, transitions?, description?, aliases?, dry_run?)` — states with optional "Run script" actions and pre/postcondition scripts; transitions by state name, manual or automatic (after N days, by script, on assignment completion).
- `mfiles_update_workflow(vault_guid, workflow, rename?, description?, add_states?, update_states?, add_transitions?, update_transitions?, remove_transitions?, dry_run?)` — the answer includes the previous version of everything it changed.
- `mfiles_set_event_handler(vault_guid, guid?, event_type?, name?, script?, active?, create_new?, dry_run?)` — add a VBScript event handler or change one; switch one off with `active: false`.

None of these delete structure. The only removals are taking a property off a class and removing a workflow transition.

The app makes changes that read before they write (class, workflow, event handler and property updates) through its own admin session, opened the way M-Files Admin opens one. It first logs in as the Windows account it runs under. If that fails, this server sends `MFILES_USERNAME` and `MFILES_PASSWORD` (plus `MFILES_DOMAIN` for a Windows account) so the app can log in with those. Set `MFILES_STRUCTURE_LOGIN=windows` to never send them, or `credentials` to always send them. If the M-Files server doesn't listen on `ncacn_ip_tcp localhost:2266`, set `MFILES_STRUCTURE_SERVER_ENDPOINT`, e.g. `ncacn_ip_tcp:localhost:2266`.

## Example prompts

> "Authenticate from env, then describe the Patient class."
>
> "Find me anything named invoice in my vault."
>
> "What value lists are used by the Customer object type?"

With writes enabled:

> "Create a required text property Batch Number and add it to the Product and Raw Material classes. Dry run first."
>
> "On document 123, set Status to Approved and add Bob to Reviewers."
>
> "Add a Rejected state to the Contract Approval workflow, with a transition from Review that runs when the assignment is rejected."
>
> "Show me the BeforeCheckInChanges event handlers and their scripts."

## Usage notes

- Property detail always comes from `/REST/structure/properties/{id}.aspx`. The bulk list endpoint omits `ValueList` bindings in some M-Files versions, which is why `mfiles_get_property` and `mfiles_describe_class` use the detail endpoint per property.
- `mfiles_list_value_lists` filters out entries with `RealObjectType: true` — the underlying `/REST/valuelists.aspx` returns both object types and pure value lists in one payload, and we keep only the latter to match user expectations. Use `mfiles_list_object_types` for the former.
- On a 401 response the token is cleared automatically and tools return `{ error, hint }` telling the LLM to re-authenticate.
- List responses exceeding 200 items are truncated with a hint to use `mfiles_find_by_name`.
- `data_type_name` follows the MFDataType enum: `8=Boolean`, `9=SingleSelectLookup`, `10=MultiSelectLookup`, `13=MultiLineText`. Versions up to 0.1.0 mislabelled 8–13.
- PUT and DELETE are sent as POST with `?_method=PUT|DELETE`, as MFWS recommends, because IIS often blocks those verbs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: keep it vault-agnostic, log to stderr, add tests.

## License

MIT — see [LICENSE](LICENSE).
