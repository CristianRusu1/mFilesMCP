# Contributing to mcp-mfiles

Thanks for your interest. This project has a narrow scope — it's a **vault-agnostic** metadata explorer for M-Files. Changes that add vault-specific behavior or hardcode IDs will be rejected on principle (see [CLAUDE.md](CLAUDE.md)).

## Local setup

```bash
git clone https://github.com/CristianRusu1/mFilesMCP.git
cd mFilesMCP
npm install
cp .env.example .env   # fill in your own vault credentials
```

## Dev loop

```bash
npm run build     # compile TypeScript → dist/
npm test          # mocked-fetch unit tests, no vault needed
npm run smoke     # live REST smoke test against the vault in .env
npm run smoke:mcp # full MCP protocol flow test (auth + find_by_name + describe_class)
```

`npm test` is the only command that works without a real vault. Always run it before pushing.

The companion vault app in `vault-app/` builds with `dotnet build -c Release` (or Visual Studio). See [vault-app/README.md](vault-app/README.md).

## What makes a good PR

- **Keep it vault-agnostic.** No hardcoded object type, class, property, or value list IDs. All IDs come from live introspection.
- **Log to stderr only.** Stdout is the JSON-RPC channel — `console.log` corrupts the protocol. Use the `debug()` helper in [src/logger.ts](src/logger.ts).
- **Validate tool inputs with Zod.** Every new tool needs a schema.
- **Add tests with mocked fetch.** See [tests/mfiles-client.test.ts](tests/mfiles-client.test.ts) for the pattern.
- **Composite over chained.** If a new tool requires the LLM to call three other tools first, it's probably not the right shape.

## Good first issues

- Additional atomic tools from the [MFWS reference](https://developer.m-files.com/APIs/REST-API/Reference/) (views, user groups) — with tests.
- Better truncation strategies for huge vaults (e.g. pagination hints).
- Windows-path / permissions gotchas in the Claude Desktop config docs.

## Write tools

Writes exist, but stay behind `MFILES_ALLOW_WRITES=true`. New write tools must:

- be registered only in `registerObjectTools` / `registerStructureWriteTools` (both gated in `src/index.ts`);
- support `dry_run` and validate against the live structure before writing;
- carry MCP `annotations` (`readOnlyHint: false`, plus `destructiveHint`);
- have mocked-fetch tests for the request sequence, including the failure path;
- if they go through the vault app, run as a job via `runStructureJob`, and go through the app's admin session whenever they read before they write (see `vault-app/README.md`).

## What's out of scope for now

- Deleting metadata structure (property definitions, classes, value lists, workflow states, event handlers). It's too easy to do by accident from chat.
- Object search, file uploads, and workflow state changes.
- Anything vault-specific, including helpers that assume particular class names like "Patient" or "Invoice".
