import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MFilesClient } from "../mfiles-client.js";
import { sessions } from "../session.js";
import { resolvePropertyDefs } from "../object-writes.js";
import type { PropertyRef } from "../object-writes.js";
import {
  CREATABLE_DATA_TYPES,
  createClass,
  createPropertyDef,
  createValueList,
  getStructureJob,
  structureAppStatus,
  updateClass,
} from "../structure-app.js";
import type { CreatableDataTypeName } from "../structure-app.js";
import {
  AUTOMATIC_VALUE_TYPES,
  TRIGGER_MODES,
  createWorkflow,
  getWorkflow,
  listEventHandlers,
  readAdminDefinition,
  resolveWorkflow,
  setEventHandler,
  updatePropertyDef,
  updateWorkflow,
} from "../structure-admin.js";
import type { StateInput, TransitionInput, TriggerInput } from "../structure-admin.js";
import { ok, runTool } from "./shared.js";

const dataTypeEnum = z.enum(
  Object.keys(CREATABLE_DATA_TYPES) as [
    CreatableDataTypeName,
    ...CreatableDataTypeName[],
  ],
);

const NEEDS_APP =
  "Needs the MFilesMCP vault app (the M-Files REST API can't change metadata structure) and a user with the 'Change metadata structure' right. The change runs as a job in the app; if it's still running when this call returns, the answer says so with a job_id for mfiles_structure_job. Don't resubmit it.";

const propertyRef = z
  .union([z.number().int(), z.string().min(1)])
  .describe("Property definition ID (number) or exact property name (string).");

const stateRef = z
  .union([z.number().int(), z.string().min(1)])
  .describe("State ID (number) or exact state name (string).");

const workflowRef = z
  .union([z.number().int(), z.string().min(1)])
  .describe("Workflow ID (number) or exact workflow name (string).");

const classProperty = z.object({
  property: propertyRef,
  required: z.boolean().optional().default(false),
});

const SCRIPT_RULE =
  "Leaving a script field out keeps that script; an empty string switches it off.";

const trigger = z
  .object({
    mode: z.enum(TRIGGER_MODES),
    script: z
      .string()
      .optional()
      .describe("For mode \"script\": VBScript that sets AllowStateTransition = True when the transition should happen."),
    days: z.number().int().min(0).optional().describe("For mode \"days\": days after entering the from-state."),
  })
  .describe("Automatic state transition. mode \"none\" makes it manual again.");

const stateInput = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  script: z.string().optional().describe("The state's \"Run script\" action (VBScript)."),
  preconditions_script: z.string().optional().describe("VBScript precondition for entering the state."),
  postconditions_script: z.string().optional().describe("VBScript postcondition for leaving the state."),
  aliases: z.array(z.string().min(1)).optional(),
});

const transitionInput = z.object({
  from: stateRef,
  to: stateRef,
  name: z.string().optional(),
  description: z.string().optional(),
  trigger: trigger.optional(),
});

function toStateInput(s: z.infer<typeof stateInput>): StateInput {
  return {
    name: s.name,
    description: s.description,
    script: s.script,
    preconditionsScript: s.preconditions_script,
    postconditionsScript: s.postconditions_script,
    aliases: s.aliases,
  };
}

function toTrigger(t: z.infer<typeof trigger> | undefined): TriggerInput | undefined {
  return t ? { mode: t.mode, script: t.script, days: t.days } : undefined;
}

function toTransitionInput(t: z.infer<typeof transitionInput>): TransitionInput {
  return { from: t.from, to: t.to, name: t.name, description: t.description, trigger: toTrigger(t.trigger) };
}

async function resolveClassProperties(
  client: MFilesClient,
  items: Array<{ property: PropertyRef; required?: boolean }>,
) {
  const defs = await resolvePropertyDefs(client, items.map((i) => i.property));
  return defs.map((d, i) => ({ propertyId: d.ID, required: items[i].required ?? false }));
}

export function registerStructureWriteTools(server: McpServer): void {
  server.registerTool(
    "mfiles_structure_app_status",
    {
      description:
        "Check whether the MFilesMCP vault app is installed in this vault, compatible with this server, and able to open its admin session (the M-Files Admin-style login it uses for class, workflow, event handler and property updates). Every structure tool depends on it. Pass verify_class_id to compare every way the app can read that class with what REST shows.",
      inputSchema: {
        vault_guid: z.string(),
        verify_class_id: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ vault_guid, verify_class_id }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        return ok(await structureAppStatus(client, { verifyClassId: verify_class_id }));
      }),
  );

  server.registerTool(
    "mfiles_structure_job",
    {
      description:
        "Get the status and result of a structure job that was still running when its tool call returned (that answer gives the job_id). Jobs live in the vault app's memory for two hours and are lost when the vault restarts.",
      inputSchema: { vault_guid: z.string(), job_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ vault_guid, job_id }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        return ok(await getStructureJob(client, job_id));
      }),
  );

  server.registerTool(
    "mfiles_get_admin_definition",
    {
      description:
        `Read a class or property definition the way M-Files Admin sees it, including what REST leaves out: semantic aliases, a property's calculated value or automatic numbering (expression or VBScript) and its validation (regex or VBScript). For workflows use mfiles_get_workflow, for event handlers mfiles_list_event_handlers. ${NEEDS_APP}`,
      inputSchema: {
        vault_guid: z.string(),
        kind: z.enum(["class", "property_def"]),
        id: z.number().int(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ vault_guid, kind, id }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        return ok(await readAdminDefinition(client, kind, id));
      }),
  );

  server.registerTool(
    "mfiles_create_property_def",
    {
      description:
        `Create a new property definition and, optionally, add it to one or more classes in the same call. ${NEEDS_APP} Lookup types need value_list_id (a value list or object type). If neither defined_for_object_type_id nor all_object_types is given, the object type is inferred from add_to_classes. Refuses to reuse an existing property name unless allow_duplicate_name=true. Calculated values and validation are set afterwards with mfiles_update_property_def. Use dry_run=true to preview.`,
      inputSchema: {
        vault_guid: z.string(),
        name: z.string().min(1),
        data_type: dataTypeEnum,
        value_list_id: z
          .number()
          .int()
          .optional()
          .describe("Required for SingleSelectLookup / MultiSelectLookup."),
        defined_for_object_type_id: z
          .number()
          .int()
          .optional()
          .describe("The object type this property is defined for."),
        all_object_types: z
          .boolean()
          .optional()
          .describe("Make the property usable with every object type."),
        aliases: z
          .array(z.string().min(1))
          .optional()
          .default([])
          .describe("Semantic aliases, e.g. [\"MyOrg.Property.ContractNumber\"]."),
        add_to_classes: z
          .array(
            z.object({
              class_id: z.number().int(),
              required: z.boolean().optional().default(false),
            }),
          )
          .optional()
          .default([])
          .describe("Classes to associate the new property with."),
        allow_duplicate_name: z.boolean().optional().default(false),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) =>
      runTool(async () => {
        const client = sessions.require(input.vault_guid);
        return ok(
          await createPropertyDef(client, {
            name: input.name,
            dataType: input.data_type,
            valueListId: input.value_list_id,
            definedForObjectTypeId: input.defined_for_object_type_id,
            allObjectTypes: input.all_object_types,
            aliases: input.aliases ?? [],
            addToClasses: (input.add_to_classes ?? []).map((c) => ({
              classId: c.class_id,
              required: c.required ?? false,
            })),
            allowDuplicateName: input.allow_duplicate_name ?? false,
            dryRun: input.dry_run ?? false,
          }),
        );
      }),
  );

  server.registerTool(
    "mfiles_update_property_def",
    {
      description:
        `Change a property definition: rename it, add or remove semantic aliases, set its automatic value (calculated with placeholders, calculated with VBScript, automatic numbering, or automatic numbering with VBScript) and its validation (regex or VBScript). Values already on objects only change if recalculate is set. ${NEEDS_APP} Use dry_run=true to see the current definition and the planned change.`,
      inputSchema: {
        vault_guid: z.string(),
        property: propertyRef,
        rename: z.string().optional(),
        add_aliases: z.array(z.string().min(1)).optional().default([]),
        remove_aliases: z.array(z.string().min(1)).optional().default([]),
        automatic_value: z
          .object({
            type: z.enum(AUTOMATIC_VALUE_TYPES),
            expression: z
              .string()
              .optional()
              .describe("For \"calculated\": placeholder expression, e.g. \"%PROPERTY_0% (%PROPERTY_1020%)\"."),
            script: z
              .string()
              .optional()
              .describe("For \"calculated_vbscript\" and \"auto_number_vbscript\": VBScript that sets Output."),
            increment: z.number().int().optional().describe("For \"auto_number\"; default 1."),
            calculation_order: z.number().int().optional(),
          })
          .optional()
          .describe("type \"none\" removes the automatic value."),
        validation: z
          .object({
            type: z.enum(["none", "regex", "vbscript"]),
            regex: z.string().optional(),
            script: z.string().optional().describe("VBScript that raises an error to reject a value."),
          })
          .optional(),
        recalculate: z
          .enum(["none", "empty_only", "all"])
          .optional()
          .default("none")
          .describe("Recalculate existing objects' values after the change."),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (input) =>
      runTool(async () => {
        const client = sessions.require(input.vault_guid);
        const av = input.automatic_value;
        return ok(
          await updatePropertyDef(client, {
            property: input.property,
            rename: input.rename,
            addAliases: input.add_aliases ?? [],
            removeAliases: input.remove_aliases ?? [],
            automaticValue: av
              ? {
                  type: av.type,
                  expression: av.expression,
                  script: av.script,
                  increment: av.increment,
                  calculationOrder: av.calculation_order,
                }
              : undefined,
            validation: input.validation,
            recalculate: input.recalculate ?? "none",
            dryRun: input.dry_run ?? false,
          }),
        );
      }),
  );

  server.registerTool(
    "mfiles_create_class",
    {
      description:
        `Create a class for an object type, with its properties (and which are required), its name property (default Name or title) and optionally a workflow. ${NEEDS_APP} Use dry_run=true to preview.`,
      inputSchema: {
        vault_guid: z.string(),
        object_type_id: z.number().int(),
        name: z.string().min(1),
        name_property: propertyRef.optional().describe("A Text property used as the objects' name. Default: Name or title."),
        properties: z.array(classProperty).optional().default([]),
        workflow: workflowRef.optional(),
        force_workflow: z.boolean().optional().default(false),
        aliases: z.array(z.string().min(1)).optional().default([]),
        allow_duplicate_name: z.boolean().optional().default(false),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) =>
      runTool(async () => {
        const client = sessions.require(input.vault_guid);
        const [properties, nameProperty, workflow] = await Promise.all([
          resolveClassProperties(client, input.properties ?? []),
          input.name_property !== undefined
            ? resolvePropertyDefs(client, [input.name_property]).then((d) => d[0])
            : undefined,
          input.workflow !== undefined ? resolveWorkflow(client, input.workflow) : undefined,
        ]);
        return ok(
          await createClass(client, {
            objectTypeId: input.object_type_id,
            name: input.name,
            namePropertyId: nameProperty?.ID,
            properties,
            workflowId: workflow?.ID,
            forceWorkflow: input.force_workflow ?? false,
            aliases: input.aliases ?? [],
            allowDuplicateName: input.allow_duplicate_name ?? false,
            dryRun: input.dry_run ?? false,
          }),
        );
      }),
  );

  server.registerTool(
    "mfiles_update_class",
    {
      description:
        `Change a class: add properties, remove them, change whether they're required, rename the class, set or remove its workflow (workflow=null), force the workflow, or change its name property. Listing a property in add that's already on the class just updates its required flag. ${NEEDS_APP} The app only saves a copy of the class that matches what REST shows, and the result is checked over REST afterwards. Use dry_run=true to preview.`,
      inputSchema: {
        vault_guid: z.string(),
        class_id: z.number().int(),
        add: z.array(classProperty).optional().default([]),
        remove: z
          .array(propertyRef)
          .optional()
          .default([])
          .describe("Properties to take off the class."),
        rename: z.string().optional(),
        workflow: workflowRef.nullable().optional().describe("null removes the class's workflow."),
        force_workflow: z.boolean().optional(),
        name_property: propertyRef.optional(),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (input) =>
      runTool(async () => {
        const client = sessions.require(input.vault_guid);
        const [add, removeDefs, nameProperty, workflow] = await Promise.all([
          resolveClassProperties(client, input.add ?? []),
          resolvePropertyDefs(client, input.remove ?? []),
          input.name_property !== undefined
            ? resolvePropertyDefs(client, [input.name_property]).then((d) => d[0])
            : undefined,
          input.workflow !== undefined && input.workflow !== null
            ? resolveWorkflow(client, input.workflow)
            : undefined,
        ]);
        return ok(
          await updateClass(client, {
            classId: input.class_id,
            add,
            remove: removeDefs.map((d) => d.ID),
            rename: input.rename,
            workflowId: input.workflow === null ? null : workflow?.ID,
            forceWorkflow: input.force_workflow,
            namePropertyId: nameProperty?.ID,
            dryRun: input.dry_run ?? false,
          }),
        );
      }),
  );

  server.registerTool(
    "mfiles_create_value_list",
    {
      description:
        `Create a new plain value list, optionally with initial items. ${NEEDS_APP} Use the returned ID as value_list_id in mfiles_create_property_def to make a lookup property. Use dry_run=true to preview.`,
      inputSchema: {
        vault_guid: z.string(),
        name_singular: z.string().min(1),
        name_plural: z
          .string()
          .optional()
          .describe("Defaults to name_singular."),
        items: z.array(z.string().min(1)).optional().default([]),
        aliases: z.array(z.string().min(1)).optional().default([]),
        allow_duplicate_name: z.boolean().optional().default(false),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) =>
      runTool(async () => {
        const client = sessions.require(input.vault_guid);
        return ok(
          await createValueList(client, {
            nameSingular: input.name_singular,
            namePlural: input.name_plural,
            aliases: input.aliases ?? [],
            items: input.items ?? [],
            allowDuplicateName: input.allow_duplicate_name ?? false,
            dryRun: input.dry_run ?? false,
          }),
        );
      }),
  );

  server.registerTool(
    "mfiles_get_workflow",
    {
      description:
        `Read a workflow the way M-Files Admin sees it: every state with its description, "Run script" action, pre- and postcondition scripts and other switched-on actions, and every transition with its trigger (manual, days, script, assignment) and trigger script. ${NEEDS_APP}`,
      inputSchema: { vault_guid: z.string(), workflow: workflowRef },
      annotations: { readOnlyHint: true },
    },
    async ({ vault_guid, workflow }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        return ok(await getWorkflow(client, workflow));
      }),
  );

  server.registerTool(
    "mfiles_create_workflow",
    {
      description:
        `Create a workflow with its states and transitions in one call. Transitions name their states. States can carry a "Run script" action and pre/postcondition scripts; transitions can be automatic (after N days, by script, on assignment completion). ${NEEDS_APP} Attach the new workflow to a class with mfiles_update_class. Use dry_run=true to preview.`,
      inputSchema: {
        vault_guid: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
        aliases: z.array(z.string().min(1)).optional().default([]),
        states: z.array(stateInput).min(1),
        transitions: z.array(transitionInput).optional().default([]),
        allow_duplicate_name: z.boolean().optional().default(false),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) =>
      runTool(async () => {
        const client = sessions.require(input.vault_guid);
        return ok(
          await createWorkflow(client, {
            name: input.name,
            description: input.description,
            aliases: input.aliases ?? [],
            states: input.states.map(toStateInput),
            transitions: (input.transitions ?? []).map(toTransitionInput),
            allowDuplicateName: input.allow_duplicate_name ?? false,
            dryRun: input.dry_run ?? false,
          }),
        );
      }),
  );

  server.registerTool(
    "mfiles_update_workflow",
    {
      description:
        `Change a workflow: rename it or its states, edit descriptions, set or switch off state scripts ("Run script" action, pre/postconditions), add states, add transitions (to new or existing states), change transitions (ends, name, trigger and trigger script) and remove transitions. States are never removed. ${SCRIPT_RULE} ${NEEDS_APP} Read it first with mfiles_get_workflow; use dry_run=true to preview. The result includes the previous version of everything changed.`,
      inputSchema: {
        vault_guid: z.string(),
        workflow: workflowRef,
        rename: z.string().optional(),
        description: z.string().optional(),
        add_states: z.array(stateInput).optional().default([]),
        update_states: z
          .array(
            z.object({
              state: stateRef,
              rename: z.string().optional(),
              description: z.string().optional(),
              script: z.string().optional(),
              preconditions_script: z.string().optional(),
              postconditions_script: z.string().optional(),
            }),
          )
          .optional()
          .default([]),
        add_transitions: z.array(transitionInput).optional().default([]),
        update_transitions: z
          .array(
            z.object({
              id: z.number().int().describe("Transition ID from mfiles_get_workflow."),
              from: stateRef.optional(),
              to: stateRef.optional(),
              name: z.string().optional(),
              description: z.string().optional(),
              trigger: trigger.optional(),
            }),
          )
          .optional()
          .default([]),
        remove_transitions: z.array(z.number().int()).optional().default([]),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (input) =>
      runTool(async () => {
        const client = sessions.require(input.vault_guid);
        return ok(
          await updateWorkflow(client, {
            workflow: input.workflow,
            rename: input.rename,
            description: input.description,
            addStates: (input.add_states ?? []).map(toStateInput),
            updateStates: (input.update_states ?? []).map((u) => ({
              state: u.state,
              rename: u.rename,
              description: u.description,
              script: u.script,
              preconditionsScript: u.preconditions_script,
              postconditionsScript: u.postconditions_script,
            })),
            addTransitions: (input.add_transitions ?? []).map(toTransitionInput),
            updateTransitions: (input.update_transitions ?? []).map((u) => ({
              id: u.id,
              from: u.from,
              to: u.to,
              name: u.name,
              description: u.description,
              trigger: toTrigger(u.trigger),
            })),
            removeTransitions: input.remove_transitions ?? [],
            dryRun: input.dry_run ?? false,
          }),
        );
      }),
  );

  server.registerTool(
    "mfiles_list_event_handlers",
    {
      description:
        `List the vault's VBScript event handlers (M-Files Admin → Event Handlers), including VaultExtensionMethod handlers: GUID, event type, name, whether active, and optionally the script. Filter by event_type (e.g. BeforeCheckInChanges) or by part of the name. The stub handlers M-Files generates for vault applications are left out unless include_app_generated=true. ${NEEDS_APP}`,
      inputSchema: {
        vault_guid: z.string(),
        event_type: z.string().optional(),
        name: z.string().optional().describe("Part of the handler's name (its description)."),
        include_scripts: z.boolean().optional().default(false),
        include_app_generated: z
          .boolean()
          .optional()
          .default(false)
          .describe("Also list the stub handlers M-Files generates for vault applications' extension methods."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ vault_guid, event_type, name, include_scripts, include_app_generated }) =>
      runTool(async () => {
        const client = sessions.require(vault_guid);
        return ok(
          await listEventHandlers(client, {
            eventType: event_type,
            name,
            includeScripts: include_scripts ?? false,
            includeAppGenerated: include_app_generated ?? false,
          }),
        );
      }),
  );

  server.registerTool(
    "mfiles_set_event_handler",
    {
      description:
        `Add a VBScript event handler or change one (script, name, event type, active). Identify an existing handler by guid; without a guid, a handler with the same event_type and name is changed rather than duplicated (create_new=true adds another). Handlers are never deleted: set active=false to switch one off. For a VaultExtensionMethod handler, name is the method name. ${NEEDS_APP} Every other handler is checked to be unchanged afterwards, and the result includes the previous version. Use dry_run=true to preview.`,
      inputSchema: {
        vault_guid: z.string(),
        guid: z.string().optional(),
        event_type: z
          .string()
          .optional()
          .describe("e.g. BeforeCheckInChanges, AfterCreateNewObjectFinalize, VaultExtensionMethod. Required for a new handler."),
        name: z.string().optional(),
        script: z.string().optional().describe("The full VBScript. Required for a new handler."),
        active: z.boolean().optional(),
        create_new: z.boolean().optional().default(false),
        dry_run: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (input) =>
      runTool(async () => {
        const client = sessions.require(input.vault_guid);
        return ok(
          await setEventHandler(client, {
            guid: input.guid,
            eventType: input.event_type,
            name: input.name,
            script: input.script,
            active: input.active,
            createNew: input.create_new ?? false,
            dryRun: input.dry_run ?? false,
          }),
        );
      }),
  );
}
