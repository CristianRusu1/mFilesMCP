import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessions } from "../session.js";
import { resolveDataTypeName } from "../types.js";
import type {
  MFilesClass,
  MFilesObjectType,
  MFilesPropertyDef,
  MFilesValueList,
  MFilesValueListItem,
} from "../types.js";
import { ok, runTool, truncateList } from "./shared.js";

function summarizeObjectType(ot: MFilesObjectType) {
  return {
    id: ot.ID,
    name: ot.Name,
    name_plural: ot.NamePlural,
    real_object_type: ot.RealObjectType,
    owner_type: ot.OwnerType,
    default_property_def: ot.DefaultPropertyDef,
  };
}

function summarizeClass(c: MFilesClass) {
  const assoc = c.AssociatedPropertyDefs ?? [];
  return {
    id: c.ID,
    name: c.Name,
    object_type: c.ObjectType,
    name_property_def: c.NamePropertyDef,
    associated_property_defs: assoc.map((a) => ({
      property_def: a.PropertyDef,
      required: a.Required,
    })),
    workflow: c.Workflow,
    forced_workflow: c.ForcedWorkflow,
  };
}

function summarizeProperty(p: MFilesPropertyDef) {
  const out: Record<string, unknown> = {
    id: p.ID,
    name: p.Name,
    data_type: p.DataType,
    data_type_name: resolveDataTypeName(p.DataType),
  };
  if (typeof p.ValueList === "number" && p.ValueList > 0) {
    out.value_list = p.ValueList;
    out._hint = `Bound to value list ${p.ValueList}. Use mfiles_get_value_list_items to retrieve allowed values.`;
  }
  if (typeof p.ObjectType === "number") out.object_type = p.ObjectType;
  if (typeof p.AutomaticValueType === "number" && p.AutomaticValueType !== 0) {
    out.automatic_value_type = p.AutomaticValueType;
  }
  return out;
}

function summarizeValueList(vl: MFilesValueList) {
  return {
    id: vl.ID,
    name: vl.Name,
    real_object_type: vl.RealObjectType ?? false,
    has_owner: vl.HasOwner,
    owner: vl.Owner,
  };
}

function summarizeValueListItem(item: MFilesValueListItem) {
  return {
    id: item.ID,
    name: item.Name,
    has_owner: item.HasOwner,
    owner_id: item.OwnerID,
  };
}

export function registerStructureTools(server: McpServer): void {
  server.registerTool(
    "mfiles_list_object_types",
    {
      description:
        "List all object types in the vault (e.g. Document, Customer, Patient). Returns id + name for each.",
      inputSchema: {
        vault_guid: z.string(),
      },
    },
    async ({ vault_guid }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        const raw = await client.listObjectTypes();
        const list = raw.map(summarizeObjectType);
        const { items, ...meta } = truncateList(
          list,
          "Use mfiles_find_by_name with kind=\"object_type\" to filter.",
        );
        return ok({ object_types: items, ...meta });
      }),
  );

  server.registerTool(
    "mfiles_list_classes",
    {
      description:
        "List classes in the vault. Optionally filter to a single object type by passing object_type_id.",
      inputSchema: {
        vault_guid: z.string(),
        object_type_id: z.number().int().optional(),
      },
    },
    async ({ vault_guid, object_type_id }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        const raw = await client.listClasses(object_type_id);
        const list = raw.map(summarizeClass);
        const { items, ...meta } = truncateList(
          list,
          "Use mfiles_find_by_name with kind=\"class\" to filter, or pass object_type_id.",
        );
        return ok({ classes: items, ...meta });
      }),
  );

  server.registerTool(
    "mfiles_get_class",
    {
      description:
        "Get the detail of a single class, including its associated property definitions.",
      inputSchema: {
        vault_guid: z.string(),
        class_id: z.number().int(),
      },
    },
    async ({ vault_guid, class_id }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        const c = await client.getClass(class_id);
        return ok({
          class: summarizeClass(c),
          _hint:
            "To expand properties and value lists in one call, use mfiles_describe_class.",
        });
      }),
  );

  server.registerTool(
    "mfiles_list_properties",
    {
      description:
        "List all property definitions in the vault. Note: the bulk list may omit ValueList bindings — use mfiles_get_property for authoritative detail.",
      inputSchema: { vault_guid: z.string() },
    },
    async ({ vault_guid }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        const raw = await client.listProperties();
        const list = raw.map(summarizeProperty);
        const { items, ...meta } = truncateList(
          list,
          "Use mfiles_find_by_name with kind=\"property\" to filter.",
        );
        return ok({ properties: items, ...meta });
      }),
  );

  server.registerTool(
    "mfiles_get_property",
    {
      description:
        "Get the full definition of a single property, including ValueList binding. Always uses the detail endpoint.",
      inputSchema: {
        vault_guid: z.string(),
        property_id: z.number().int(),
      },
    },
    async ({ vault_guid, property_id }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        const p = await client.getProperty(property_id);
        return ok({ property: summarizeProperty(p) });
      }),
  );

  server.registerTool(
    "mfiles_list_value_lists",
    {
      description:
        "List all value lists in the vault. Use mfiles_get_value_list_items to fetch the items of a specific list.",
      inputSchema: { vault_guid: z.string() },
    },
    async ({ vault_guid }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        const raw = await client.listValueLists();
        const list = raw.map(summarizeValueList);
        const { items, ...meta } = truncateList(
          list,
          "Use mfiles_find_by_name with kind=\"value_list\" to filter.",
        );
        return ok({ value_lists: items, ...meta });
      }),
  );

  server.registerTool(
    "mfiles_get_value_list_items",
    {
      description:
        "List the items (allowed values) of a specific value list.",
      inputSchema: {
        vault_guid: z.string(),
        value_list_id: z.number().int(),
      },
    },
    async ({ vault_guid, value_list_id }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        const raw = await client.getValueListItems(value_list_id);
        const list = raw.map(summarizeValueListItem);
        const { items, ...meta } = truncateList(
          list,
          "Consider filtering by name using application logic — the REST endpoint returns all items.",
        );
        return ok({
          value_list_id,
          items,
          ...meta,
        });
      }),
  );
}
