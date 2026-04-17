import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MFilesClient } from "../mfiles-client.js";
import { sessions } from "../session.js";
import { fail, ok, runTool } from "./shared.js";

function readEnvCreds() {
  const { MFILES_URL, MFILES_VAULT_GUID, MFILES_USERNAME, MFILES_PASSWORD } =
    process.env;
  const missing: string[] = [];
  if (!MFILES_URL) missing.push("MFILES_URL");
  if (!MFILES_VAULT_GUID) missing.push("MFILES_VAULT_GUID");
  if (!MFILES_USERNAME) missing.push("MFILES_USERNAME");
  if (!MFILES_PASSWORD) missing.push("MFILES_PASSWORD");
  if (missing.length) {
    return { missing, creds: null as null };
  }
  return {
    missing: [],
    creds: {
      url: MFILES_URL!,
      vaultGuid: MFILES_VAULT_GUID!,
      username: MFILES_USERNAME!,
      password: MFILES_PASSWORD!,
    },
  };
}

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "mfiles_authenticate_from_env",
    {
      description:
        "Authenticate against the M-Files vault configured in environment variables (MFILES_URL, MFILES_VAULT_GUID, MFILES_USERNAME, MFILES_PASSWORD). No arguments. Use this as the default first call.",
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        const { missing, creds } = readEnvCreds();
        if (!creds) {
          return fail(
            `Missing environment variables: ${missing.join(", ")}`,
            "Set these in the Claude Desktop config 'env' block, then restart Claude Desktop.",
          );
        }
        const client = new MFilesClient(creds.url);
        const session = await client.authenticate(
          creds.vaultGuid,
          creds.username,
          creds.password,
        );
        sessions.set(creds.vaultGuid, {
          client,
          url: creds.url,
          token: session.token,
          expiresAt: session.expiresAt,
        });
        return ok({
          authenticated: true,
          vault_guid: creds.vaultGuid,
          url: creds.url,
          expires_at: session.expiresAt.toISOString(),
          _hint:
            "Use this vault_guid in subsequent tool calls, e.g. mfiles_list_object_types.",
        });
      }),
  );

  server.registerTool(
    "mfiles_authenticate",
    {
      description:
        "Authenticate against an arbitrary M-Files vault with inline credentials. Prefer mfiles_authenticate_from_env unless connecting to a different vault than the one configured in env vars.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe("Base URL of the vault, e.g. https://vault.example.com"),
        vault_guid: z
          .string()
          .describe("Vault GUID, with or without braces."),
        username: z.string(),
        password: z.string(),
      },
    },
    async ({ url, vault_guid, username, password }) =>
      runTool(async () => {
        const client = new MFilesClient(url);
        const session = await client.authenticate(
          vault_guid,
          username,
          password,
        );
        sessions.set(vault_guid, {
          client,
          url,
          token: session.token,
          expiresAt: session.expiresAt,
        });
        return ok({
          authenticated: true,
          vault_guid,
          url,
          expires_at: session.expiresAt.toISOString(),
        });
      }),
  );

  server.registerTool(
    "mfiles_status",
    {
      description:
        "Report which vaults currently have an active session and when each token expires. Optionally filter by vault_guid.",
      inputSchema: {
        vault_guid: z
          .string()
          .optional()
          .describe("If provided, only report status for this vault."),
      },
    },
    async ({ vault_guid }) =>
      runTool(async () => {
        const all = sessions.list();
        if (vault_guid) {
          const key = vault_guid.replace(/[{}]/g, "").toUpperCase();
          const match = all.find(
            (s) => s.vaultGuid.replace(/[{}]/g, "").toUpperCase() === key,
          );
          return ok({
            vault_guid,
            authenticated: !!match,
            ...(match
              ? { url: match.url, expires_at: match.expiresAt }
              : {
                  _hint:
                    "Not authenticated. Call mfiles_authenticate_from_env.",
                }),
          });
        }
        return ok({
          authenticated_vaults: all,
          ...(all.length === 0
            ? { _hint: "No active sessions. Call mfiles_authenticate_from_env." }
            : {}),
        });
      }),
  );
}
