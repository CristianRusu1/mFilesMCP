# CLAUDE.md — notes for Claude Code while working in this repo

## Product intent

- This MCP is a **vault structure explorer**. The goal is to surface object types, classes, properties, value lists, and their relationships faster than the M-Files Admin UI does.
- The server must work against **any** vault. Nothing is vault-specific.

## Hard rules

- **Never hardcode object type, class, property, or value list IDs.** They are assigned per vault and differ across environments. All IDs come from live introspection calls.
- **Log to stderr only.** Stdout is reserved for the MCP JSON-RPC channel. Using `console.log` will corrupt the protocol.
- **ESM, Node 20+, `StdioServerTransport`.**
- **Validate every tool input with Zod.** Output is always stringified JSON inside a text content block.

## Real vault-agnostic M-Files REST quirks

- Always fetch property details from `structure/properties/{id}.aspx`. The bulk `structure/properties.aspx` response omits `ValueList` bindings in some versions.
- `X-Authentication` header carries the session token. A 401 means the token expired — clear the cached session and surface an error telling the LLM to re-authenticate.
- REST date fields are ISO 8601 on the wire regardless of how the M-Files client UI displays them. Display format is a per-vault/per-user setting and not something this MCP cares about.
- `DataType` on a property definition is an integer enum (M-Files `MFDataType`). Canonical values: `0=Uninitialized`, `1=Text`, `2=Integer`, `3=Floating`, `5=Date`, `6=Time`, `7=Timestamp`, `8=SingleSelectLookup`, `9=MultiSelectLookup`, `10=MultiLineText`, `11=Boolean`, `12=FileReference`, `13=Integer64`. Include a resolved `DataTypeName` in responses. Note: plan.md's original draft had a few values swapped; this is the correct mapping from the MFWS.

## Design principles

- **Composite over chained.** When the LLM asks a high-level question ("describe the Patient class"), a composite tool should answer it in one call. Don't force the LLM to chain 10 atomic calls.
- **Errors should teach the LLM what to do next.** Return `{ error, hint }` pairs. Example hint: "Token expired — call `mfiles_authenticate_from_env` first."
- **Truncate and redirect on huge responses.** If a bulk list is massive, truncate and point the LLM at `mfiles_find_by_name` or a more specific endpoint.
