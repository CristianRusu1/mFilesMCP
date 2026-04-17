# Contributing to mcp-mfiles

Thanks for your interest. This project has a narrow scope — it's a **vault-agnostic** metadata explorer for M-Files. Changes that add vault-specific behavior or hardcode IDs will be rejected on principle (see [CLAUDE.md](CLAUDE.md)).

## Local setup

```bash
git clone https://github.com/YOUR_GH_USERNAME/mcp-mfiles.git
cd mcp-mfiles
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

## What makes a good PR

- **Keep it vault-agnostic.** No hardcoded object type, class, property, or value list IDs. All IDs come from live introspection.
- **Log to stderr only.** Stdout is the JSON-RPC channel — `console.log` corrupts the protocol. Use the `debug()` helper in [src/logger.ts](src/logger.ts).
- **Validate tool inputs with Zod.** Every new tool needs a schema.
- **Add tests with mocked fetch.** See [tests/mfiles-client.test.ts](tests/mfiles-client.test.ts) for the pattern.
- **Composite over chained.** If a new tool requires the LLM to call three other tools first, it's probably not the right shape.

## Good first issues

- Additional atomic tools from the [MFWS reference](https://developer.m-files.com/APIs/REST-API/Reference/) (workflows, views, user groups) — with tests.
- Better truncation strategies for huge vaults (e.g. pagination hints).
- Windows-path / permissions gotchas in the Claude Desktop config docs.

## What's out of scope for now

- Object reads / writes (search/get/create/update). Sketched in [plan.md](plan.md) §Phase 8 but intentionally deferred — this is a structure explorer first.
- Anything vault-specific, including helpers that assume particular class names like "Patient" or "Invoice".
