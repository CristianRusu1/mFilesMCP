import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessions } from "../session.js";
import {
  createObject,
  createValueListItem,
  getObject,
  updateObjectProperties,
} from "../object-writes.js";
import { ok, runTool } from "./shared.js";

const propertyRef = z
  .union([z.number().int(), z.string().min(1)])
  .describe("Property definition ID (number) or exact property name (string).");

const propertyValue = z
  .union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
  ])
  .nullable()
  .describe(
    "Text as a string; Integer/Floating as a number; Date \"YYYY-MM-DD\"; Time \"HH:MM[:SS]\"; Timestamp ISO 8601 UTC; Boolean true/false; lookups as an item ID (number) or exact item name (string), an array of them for MultiSelectLookup. null clears the value.",
  );

const assignment = z.object({
  property: propertyRef,
  value: propertyValue,
  append: z
    .boolean()
    .optional()
    .describe(
      "MultiSelectLookup only: add the items to the current selection instead of replacing it.",
    ),
});

const VALUE_RULES =
  "Values: text as strings, numbers as numbers, Date \"YYYY-MM-DD\", Time \"HH:MM[:SS]\", Timestamp ISO 8601 UTC, Boolean true/false, lookups as item ID (number) or exact item name (string), arrays for MultiSelectLookup, null to clear.";

export function registerObjectTools(server: McpServer): void {
  server.registerTool(
    "mfiles_get_object",
    {
      description:
        "Read one object's current metadata: title, class, checkout state and every property value (property name, data type, display value, lookup item IDs). Use it to inspect an object before and after mfiles_update_object_properties. object_id is the per-type ID shown in M-Files.",
      inputSchema: {
        vault_guid: z.string(),
        object_type_id: z.number().int(),
        object_id: z.number().int(),
        version: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Specific version number. Omit for the latest version."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ vault_guid, object_type_id, object_id, version }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        return ok(
          await getObject(client, object_type_id, object_id, version ?? "latest"),
        );
      }),
  );

  server.registerTool(
    "mfiles_update_object_properties",
    {
      description:
        `Set, clear or remove property values on an existing object. This is also how you add a property the object's class doesn't define. Check-out and check-in are handled for you: every change is applied in one checkout, and if anything fails the checkout is undone so nothing is half-saved. ${VALUE_RULES} MultiSelectLookup values replace the current selection unless append=true. Call with dry_run=true first to see the resolved values next to the current ones.`,
      inputSchema: {
        vault_guid: z.string(),
        object_type_id: z.number().int(),
        object_id: z.number().int(),
        set: z
          .array(assignment)
          .optional()
          .default([])
          .describe("Properties to add or overwrite."),
        remove: z
          .array(propertyRef)
          .optional()
          .default([])
          .describe(
            "Properties to remove from the object entirely (not just clear). Class-required properties can't be removed.",
          ),
        dry_run: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, resolve and validate everything but write nothing."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ vault_guid, object_type_id, object_id, set, remove, dry_run }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        return ok(
          await updateObjectProperties(client, {
            objectType: object_type_id,
            objectId: object_id,
            set: set ?? [],
            remove: remove ?? [],
            dryRun: dry_run ?? false,
          }),
        );
      }),
  );

  server.registerTool(
    "mfiles_create_object",
    {
      description:
        `Create a new object (without files) of the given class, with initial property values. ${VALUE_RULES} Use dry_run=true to preview: it also lists required class properties you haven't supplied.`,
      inputSchema: {
        vault_guid: z.string(),
        object_type_id: z.number().int(),
        class_id: z.number().int(),
        properties: z
          .array(assignment.omit({ append: true }))
          .optional()
          .default([])
          .describe("Initial property values. Don't include Class; it comes from class_id."),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ vault_guid, object_type_id, class_id, properties, dry_run }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        return ok(
          await createObject(client, {
            objectType: object_type_id,
            classId: class_id,
            properties: properties ?? [],
            dryRun: dry_run ?? false,
          }),
        );
      }),
  );

  server.registerTool(
    "mfiles_create_value_list_item",
    {
      description:
        "Add an item to a plain value list (for object types, use mfiles_create_object). If an item with the same name already exists it is returned instead of creating a duplicate, unless allow_duplicate=true.",
      inputSchema: {
        vault_guid: z.string(),
        value_list_id: z.number().int(),
        name: z.string().min(1),
        owner_item_id: z
          .number()
          .int()
          .optional()
          .describe("Owner item ID, for value lists that have an owner list."),
        parent_item_id: z
          .number()
          .int()
          .optional()
          .describe("Parent item ID, for hierarchical value lists."),
        allow_duplicate: z.boolean().optional().default(false),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({
      vault_guid,
      value_list_id,
      name,
      owner_item_id,
      parent_item_id,
      allow_duplicate,
      dry_run,
    }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        return ok(
          await createValueListItem(client, {
            valueListId: value_list_id,
            name,
            ownerItemId: owner_item_id,
            parentItemId: parent_item_id,
            allowDuplicate: allow_duplicate ?? false,
            dryRun: dry_run ?? false,
          }),
        );
      }),
  );
}
