import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sessions } from "../session.js";
import { resolveDataTypeName } from "../types.js";
import { ok, runTool } from "./shared.js";

export function registerCompositeTools(server: McpServer): void {
  server.registerTool(
    "mfiles_describe_class",
    {
      description:
        "High-value composite: returns a class definition, every property associated with it (resolved DataType names + ValueList bindings), and optionally the items of every referenced value list. One call replaces get_class + N × get_property + M × get_value_list_items.",
      inputSchema: {
        vault_guid: z.string(),
        class_id: z.number().int(),
        include_value_list_items: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "If true (default), fetch items of every value list referenced by this class's properties.",
          ),
      },
    },
    async ({ vault_guid, class_id, include_value_list_items = true }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        const cls = await client.getClass(class_id);
        const assoc = cls.AssociatedPropertyDefs ?? [];
        const requiredById = new Map(
          assoc.map((a) => [a.PropertyDef, a.Required] as const),
        );
        const propIds = assoc.map((a) => a.PropertyDef);
        const props = await Promise.all(
          propIds.map((id) => client.getProperty(id)),
        );

        const valueListIds = new Set<number>();
        for (const p of props) {
          if (typeof p.ValueList === "number" && p.ValueList > 0) {
            valueListIds.add(p.ValueList);
          }
        }

        const valueListItemsById = new Map<
          number,
          Array<{ id: number; name: string }>
        >();
        if (include_value_list_items && valueListIds.size > 0) {
          const entries = await Promise.all(
            [...valueListIds].map(async (id) => {
              const items = await client.getValueListItems(id);
              return [
                id,
                items.map((i) => ({ id: i.ID, name: i.Name })),
              ] as const;
            }),
          );
          for (const [id, items] of entries) {
            valueListItemsById.set(id, items);
          }
        }

        const properties = props.map((p) => {
          const base: Record<string, unknown> = {
            id: p.ID,
            name: p.Name,
            data_type: p.DataType,
            data_type_name: resolveDataTypeName(p.DataType),
            required: requiredById.get(p.ID) ?? false,
          };
          if (typeof p.ValueList === "number" && p.ValueList > 0) {
            base.value_list = {
              id: p.ValueList,
              items: valueListItemsById.get(p.ValueList) ?? null,
              items_fetched: valueListItemsById.has(p.ValueList),
            };
          }
          if (typeof p.ObjectType === "number") base.object_type = p.ObjectType;
          return base;
        });

        return ok({
          class: {
            id: cls.ID,
            name: cls.Name,
            object_type: cls.ObjectType,
            name_property_def: cls.NamePropertyDef,
            workflow: cls.Workflow,
          },
          property_count: properties.length,
          value_list_count: valueListIds.size,
          properties,
        });
      }),
  );

  server.registerTool(
    "mfiles_describe_object_type",
    {
      description:
        "Composite: return an object type with its classes and (optionally) the union of properties across those classes with resolved DataType names.",
      inputSchema: {
        vault_guid: z.string(),
        object_type_id: z.number().int(),
        include_properties: z.boolean().optional().default(true),
      },
    },
    async ({ vault_guid, object_type_id, include_properties = true }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        const [ot, classes] = await Promise.all([
          client.getObjectType(object_type_id),
          client.listClasses(object_type_id),
        ]);

        const classSummaries = classes.map((c) => ({
          id: c.ID,
          name: c.Name,
          associated_property_defs: (c.AssociatedPropertyDefs ?? []).map(
            (a) => ({ property_def: a.PropertyDef, required: a.Required }),
          ),
          workflow: c.Workflow,
        }));

        let properties: Array<{
          id: number;
          name: string;
          data_type: number;
          data_type_name: string;
          value_list?: number;
        }> | undefined;

        if (include_properties) {
          const unionIds = new Set<number>();
          for (const c of classes) {
            for (const a of c.AssociatedPropertyDefs ?? []) {
              unionIds.add(a.PropertyDef);
            }
          }
          const fetched = await Promise.all(
            [...unionIds].map((id) => client.getProperty(id)),
          );
          properties = fetched.map((p) => ({
            id: p.ID,
            name: p.Name,
            data_type: p.DataType,
            data_type_name: resolveDataTypeName(p.DataType),
            ...(typeof p.ValueList === "number" && p.ValueList > 0
              ? { value_list: p.ValueList }
              : {}),
          }));
        }

        return ok({
          object_type: {
            id: ot.ID,
            name: ot.Name,
            name_plural: ot.NamePlural,
            real_object_type: ot.RealObjectType,
            owner_type: ot.OwnerType,
          },
          class_count: classSummaries.length,
          classes: classSummaries,
          ...(properties
            ? { property_count: properties.length, properties }
            : {}),
        });
      }),
  );
}
