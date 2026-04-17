import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessions } from "../session.js";
import { ok, runTool } from "./shared.js";

const kindEnum = z.enum(["object_type", "class", "property", "value_list"]);

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    "mfiles_find_by_name",
    {
      description:
        "Case-insensitive substring search across structure kinds. Pass kind to restrict, or omit to search all four (object types, classes, properties, value lists). Replaces clicking through the admin UI hunting by name.",
      inputSchema: {
        vault_guid: z.string(),
        name: z.string().min(1),
        kind: kindEnum.optional(),
      },
    },
    async ({ vault_guid, name, kind }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        const needle = name.toLowerCase();
        const kinds = kind ? [kind] : ([...kindEnum.options] as const);

        const matches: Array<{
          kind: string;
          id: number;
          name: string;
          hint?: string;
        }> = [];

        await Promise.all(
          kinds.map(async (k) => {
            if (k === "object_type") {
              const items = await client.listObjectTypes();
              for (const i of items) {
                if (i.Name.toLowerCase().includes(needle)) {
                  matches.push({
                    kind: k,
                    id: i.ID,
                    name: i.Name,
                    hint: `Call mfiles_describe_object_type with object_type_id=${i.ID} for a full tree.`,
                  });
                }
              }
            } else if (k === "class") {
              const items = await client.listClasses();
              for (const i of items) {
                if (i.Name.toLowerCase().includes(needle)) {
                  matches.push({
                    kind: k,
                    id: i.ID,
                    name: i.Name,
                    hint: `Call mfiles_describe_class with class_id=${i.ID} for properties + value lists.`,
                  });
                }
              }
            } else if (k === "property") {
              const items = await client.listProperties();
              for (const i of items) {
                if (i.Name.toLowerCase().includes(needle)) {
                  matches.push({
                    kind: k,
                    id: i.ID,
                    name: i.Name,
                    hint: `Call mfiles_get_property with property_id=${i.ID} for authoritative detail incl. ValueList binding.`,
                  });
                }
              }
            } else {
              const items = await client.listValueLists();
              for (const i of items) {
                if (i.Name.toLowerCase().includes(needle)) {
                  matches.push({
                    kind: k,
                    id: i.ID,
                    name: i.Name,
                    hint: `Call mfiles_get_value_list_items with value_list_id=${i.ID}.`,
                  });
                }
              }
            }
          }),
        );

        return ok({
          query: { name, kind: kind ?? "all" },
          match_count: matches.length,
          matches,
          ...(matches.length === 0
            ? {
                _hint:
                  "No matches. Try a shorter or different substring, or drop the kind filter.",
              }
            : {}),
        });
      }),
  );
}
