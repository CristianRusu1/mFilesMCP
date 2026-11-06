import type { MFilesClient } from "./mfiles-client.js";
import { resolvePropertyDefs } from "./object-writes.js";
import type { PropertyRef } from "./object-writes.js";
import {
  STRUCTURE_APP_METHODS,
  requireCompatibleApp,
  runStructureJob,
  sameName,
} from "./structure-app.js";
import { MFilesToolError, isLookupDataType } from "./types.js";
import type { MFilesWorkflow, MFilesWorkflowState } from "./types.js";

/**
 * Structure the REST API doesn't show at all — workflow states and
 * transitions with their scripts, VBScript event handlers, calculated values
 * and validation — read and changed through the vault app's admin session.
 */

export type AdminDefinitionKind = "class" | "property_def" | "workflow" | "event_handlers";

/** An admin definition exactly as the vault app reads it. */
export async function readAdminDefinition<T>(
  client: MFilesClient,
  kind: AdminDefinitionKind,
  id?: number,
): Promise<T> {
  await requireCompatibleApp(client);
  const { result } = await runStructureJob<T>(client, STRUCTURE_APP_METHODS.read, {
    kind,
    ...(id !== undefined ? { id } : {}),
  });
  return result;
}

// ---------------------------------------------------------------------------
// Workflows

export interface AdminStateConditions {
  script_enabled: boolean;
  script?: string | null;
  property_conditions: boolean;
}

export interface AdminState {
  id: number;
  name: string;
  description?: string | null;
  aliases: string[];
  run_script: boolean;
  script?: string | null;
  preconditions?: AdminStateConditions | null;
  postconditions?: AdminStateConditions | null;
  actions: string[];
  restrict_transitions: boolean;
}

export interface AdminTransition {
  id: number;
  name?: string | null;
  description?: string | null;
  from_state: number;
  to_state: number;
  trigger: string;
  trigger_in_days?: number | null;
  trigger_script?: string | null;
  evaluation_order: number;
  aliases: string[];
}

export interface AdminWorkflow {
  id: number;
  name: string;
  object_class?: number | null;
  description?: string | null;
  aliases: string[];
  states: AdminState[];
  transitions: AdminTransition[];
}

export const TRIGGER_MODES = [
  "none",
  "script",
  "days",
  "assignment_complete",
  "assignment_complete_one",
  "assignment_complete_all",
  "assignment_rejected",
] as const;

export type TriggerMode = (typeof TRIGGER_MODES)[number];

export interface TriggerInput {
  mode: TriggerMode;
  script?: string;
  days?: number;
}

export interface StateInput {
  name: string;
  description?: string;
  script?: string;
  preconditionsScript?: string;
  postconditionsScript?: string;
  aliases?: string[];
}

export type StateRef = number | string;

export interface TransitionInput {
  from: StateRef;
  to: StateRef;
  name?: string;
  description?: string;
  trigger?: TriggerInput;
}

export async function resolveWorkflow(
  client: MFilesClient,
  ref: number | string,
): Promise<MFilesWorkflow> {
  if (typeof ref === "number") return client.getWorkflow(ref);
  const all = await client.listWorkflows();
  const matches = all.filter((w) => sameName(w.Name, ref));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new MFilesToolError(
      `${matches.length} workflows are named "${ref}": ${matches.map((w) => w.ID).join(", ")}.`,
      "Pass the workflow's ID instead of its name.",
    );
  }
  const near = all
    .filter((w) => w.Name.toLowerCase().includes(ref.trim().toLowerCase()))
    .slice(0, 10)
    .map((w) => `${w.ID} "${w.Name}"`);
  throw new MFilesToolError(
    `No workflow is named "${ref}".`,
    near.length
      ? `Workflows with similar names: ${near.join(", ")}. Pass the ID or the exact name.`
      : "Pass the workflow's ID, or its exact name.",
  );
}

/** Adds state names next to the state IDs in transitions. */
function annotate(workflow: AdminWorkflow) {
  const names = new Map(workflow.states.map((s) => [s.id, s.name]));
  return {
    ...workflow,
    transitions: workflow.transitions.map((t) => ({
      ...t,
      from_state_name: names.get(t.from_state),
      to_state_name: names.get(t.to_state),
    })),
  };
}

export async function getWorkflow(client: MFilesClient, ref: number | string) {
  const workflow = await resolveWorkflow(client, ref);
  return annotate(await readAdminDefinition<AdminWorkflow>(client, "workflow", workflow.ID));
}

function checkTrigger(trigger: TriggerInput | undefined, where: string) {
  if (!trigger) return;
  if (trigger.mode === "script" && !trigger.script?.trim()) {
    throw new MFilesToolError(`${where}: trigger mode "script" needs trigger.script.`, "Pass the VBScript that sets AllowStateTransition = True.");
  }
  if (trigger.mode === "days" && (trigger.days === undefined || trigger.days < 0)) {
    throw new MFilesToolError(`${where}: trigger mode "days" needs trigger.days (0 or more).`, "Pass how many days after entering the state the transition happens.");
  }
}

function triggerRequest(trigger: TriggerInput | undefined) {
  if (!trigger) return undefined;
  return {
    mode: trigger.mode,
    ...(trigger.script !== undefined ? { script: trigger.script } : {}),
    ...(trigger.days !== undefined ? { days: trigger.days } : {}),
  };
}

function stateRequest(s: StateInput) {
  return {
    name: s.name.trim(),
    ...(s.description !== undefined ? { description: s.description } : {}),
    ...(s.script !== undefined ? { script: s.script } : {}),
    ...(s.preconditionsScript !== undefined ? { preconditions_script: s.preconditionsScript } : {}),
    ...(s.postconditionsScript !== undefined ? { postconditions_script: s.postconditionsScript } : {}),
    ...(s.aliases?.length ? { aliases: s.aliases } : {}),
  };
}

function requireUniqueStateNames(names: string[], existing: string[] = []) {
  const seen = new Set(existing.map((n) => n.trim().toLowerCase()));
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key) throw new MFilesToolError("A state name is empty.", "Give every state a name.");
    if (seen.has(key)) {
      throw new MFilesToolError(`There's already a state named "${name}" in this workflow.`, "State names must be unique within a workflow.");
    }
    seen.add(key);
  }
}

export interface CreateWorkflowArgs {
  name: string;
  description?: string;
  aliases: string[];
  states: StateInput[];
  transitions: TransitionInput[];
  allowDuplicateName: boolean;
  dryRun: boolean;
}

export async function createWorkflow(client: MFilesClient, args: CreateWorkflowArgs) {
  const name = args.name.trim();
  if (!name) throw new MFilesToolError("The workflow name is empty.", "Pass a non-blank name.");
  if (args.states.length === 0) {
    throw new MFilesToolError("A workflow needs at least one state.", "Pass states.");
  }
  requireUniqueStateNames(args.states.map((s) => s.name));
  const stateNames = args.states.map((s) => s.name.trim().toLowerCase());
  args.transitions.forEach((t, i) => {
    for (const [end, ref] of [["from", t.from], ["to", t.to]] as const) {
      if (typeof ref === "number" || !stateNames.includes(ref.trim().toLowerCase())) {
        throw new MFilesToolError(
          `transitions[${i}].${end} must name one of the new states (${args.states.map((s) => `"${s.name}"`).join(", ")}).`,
          "In a new workflow, transitions refer to states by name.",
        );
      }
    }
    checkTrigger(t.trigger, `transitions[${i}]`);
  });

  const existing = await client.listWorkflows();
  const duplicates = existing.filter((w) => sameName(w.Name, name));
  if (duplicates.length && !args.allowDuplicateName) {
    throw new MFilesToolError(
      `A workflow named "${name}" already exists: ${duplicates.map((w) => w.ID).join(", ")}.`,
      "Change it with mfiles_update_workflow, pick another name, or pass allow_duplicate_name=true.",
    );
  }

  const request = {
    name,
    ...(args.description !== undefined ? { description: args.description } : {}),
    aliases: args.aliases,
    states: args.states.map(stateRequest),
    transitions: args.transitions.map((t) => ({
      from_state_name: String(t.from).trim(),
      to_state_name: String(t.to).trim(),
      ...(t.name !== undefined ? { name: t.name } : {}),
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.trigger ? { trigger: triggerRequest(t.trigger) } : {}),
    })),
  };
  if (args.dryRun) {
    return {
      dry_run: true,
      workflow: request,
      _hint: "Nothing was written. Call again with dry_run=false to create the workflow, then attach it to a class with mfiles_update_class workflow=<new id>.",
    };
  }

  await requireCompatibleApp(client);
  const { result, diagnostics } = await runStructureJob<AdminWorkflow>(
    client,
    STRUCTURE_APP_METHODS.createWorkflow,
    request,
  );
  return {
    created: true,
    workflow: annotate(result),
    ...(diagnostics ? { vault_app: diagnostics } : {}),
    _hint: `Attach it to a class with mfiles_update_class workflow=${result.id}.`,
  };
}

export interface UpdateWorkflowArgs {
  workflow: number | string;
  rename?: string;
  description?: string;
  addStates: StateInput[];
  updateStates: Array<{
    state: StateRef;
    rename?: string;
    description?: string;
    script?: string;
    preconditionsScript?: string;
    postconditionsScript?: string;
  }>;
  addTransitions: TransitionInput[];
  updateTransitions: Array<{
    id: number;
    from?: StateRef;
    to?: StateRef;
    name?: string;
    description?: string;
    trigger?: TriggerInput;
  }>;
  removeTransitions: number[];
  dryRun: boolean;
}

function resolveExistingState(states: MFilesWorkflowState[], ref: StateRef, where: string): MFilesWorkflowState {
  const found =
    typeof ref === "number"
      ? states.filter((s) => s.ID === ref)
      : states.filter((s) => sameName(s.Name, ref));
  if (found.length === 1) return found[0];
  throw new MFilesToolError(
    found.length
      ? `${where}: several states are named "${ref}" (${found.map((s) => s.ID).join(", ")}).`
      : `${where}: the workflow has no state ${typeof ref === "number" ? ref : `named "${ref}"`}.`,
    `States: ${states.map((s) => `${s.ID} "${s.Name}"`).join(", ")}.`,
  );
}

export async function updateWorkflow(client: MFilesClient, args: UpdateWorkflowArgs) {
  const workflow = await resolveWorkflow(client, args.workflow);
  const states = await client.getWorkflowStates(workflow.ID);
  if (args.rename !== undefined && !args.rename.trim()) {
    throw new MFilesToolError("rename is empty.", "Pass the workflow's new name, or leave rename out.");
  }
  requireUniqueStateNames(args.addStates.map((s) => s.name), states.map((s) => s.Name));
  const newNames = args.addStates.map((s) => s.name.trim().toLowerCase());

  const updateStates = args.updateStates.map((u, i) => {
    const state = resolveExistingState(states, u.state, `update_states[${i}].state`);
    if (u.rename !== undefined && !u.rename.trim()) {
      throw new MFilesToolError(`update_states[${i}].rename is empty.`, "Pass the state's new name, or leave rename out.");
    }
    return {
      id: state.ID,
      ...(u.rename !== undefined ? { name: u.rename.trim() } : {}),
      ...(u.description !== undefined ? { description: u.description } : {}),
      ...(u.script !== undefined ? { script: u.script } : {}),
      ...(u.preconditionsScript !== undefined ? { preconditions_script: u.preconditionsScript } : {}),
      ...(u.postconditionsScript !== undefined ? { postconditions_script: u.postconditionsScript } : {}),
    };
  });

  const endpoint = (ref: StateRef, key: "from" | "to", where: string) => {
    if (typeof ref === "string" && newNames.includes(ref.trim().toLowerCase())) {
      return { [`${key}_state_name`]: ref.trim() };
    }
    return { [`${key}_state`]: resolveExistingState(states, ref, where).ID };
  };
  const addTransitions = args.addTransitions.map((t, i) => {
    checkTrigger(t.trigger, `add_transitions[${i}]`);
    return {
      ...endpoint(t.from, "from", `add_transitions[${i}].from`),
      ...endpoint(t.to, "to", `add_transitions[${i}].to`),
      ...(t.name !== undefined ? { name: t.name } : {}),
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.trigger ? { trigger: triggerRequest(t.trigger) } : {}),
    };
  });
  const updateTransitions = args.updateTransitions.map((u, i) => {
    checkTrigger(u.trigger, `update_transitions[${i}]`);
    return {
      id: u.id,
      ...(u.from !== undefined ? { from_state: resolveExistingState(states, u.from, `update_transitions[${i}].from`).ID } : {}),
      ...(u.to !== undefined ? { to_state: resolveExistingState(states, u.to, `update_transitions[${i}].to`).ID } : {}),
      ...(u.name !== undefined ? { name: u.name } : {}),
      ...(u.description !== undefined ? { description: u.description } : {}),
      ...(u.trigger ? { trigger: triggerRequest(u.trigger) } : {}),
    };
  });
  const removeTransitions = [...new Set(args.removeTransitions)];

  const request = {
    workflow_id: workflow.ID,
    expected: { name: workflow.Name, states: states.map((s) => s.ID) },
    ...(args.rename !== undefined ? { name: args.rename.trim() } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    add_states: args.addStates.map(stateRequest),
    update_states: updateStates,
    add_transitions: addTransitions,
    update_transitions: updateTransitions,
    remove_transitions: removeTransitions,
  };
  const changeCount =
    request.add_states.length +
    updateStates.length +
    addTransitions.length +
    updateTransitions.length +
    removeTransitions.length +
    (args.rename !== undefined ? 1 : 0) +
    (args.description !== undefined ? 1 : 0);
  if (changeCount === 0) {
    throw new MFilesToolError("Nothing to change.", "Pass at least one of rename, description, add_states, update_states, add_transitions, update_transitions, remove_transitions.");
  }

  if (args.dryRun) {
    // Show what the touched states and transitions look like now.
    const current = annotate(await readAdminDefinition<AdminWorkflow>(client, "workflow", workflow.ID));
    const touchedStates = new Set(updateStates.map((u) => u.id));
    const touchedTransitions = new Set([...updateTransitions.map((u) => u.id), ...removeTransitions]);
    const unknown = [...touchedTransitions].filter((id) => !current.transitions.some((t) => t.id === id));
    if (unknown.length) {
      throw new MFilesToolError(
        `Workflow ${workflow.ID} has no transition ${unknown.join(", ")}.`,
        `Its transitions: ${current.transitions.map((t) => `${t.id} (${t.from_state_name} → ${t.to_state_name})`).join(", ")}.`,
      );
    }
    return {
      dry_run: true,
      workflow: { id: workflow.ID, name: workflow.Name },
      changes: request,
      current: {
        states: current.states.filter((s) => touchedStates.has(s.id)),
        transitions: current.transitions.filter((t) => touchedTransitions.has(t.id)),
      },
      _hint: "Nothing was written. Call again with dry_run=false to apply.",
    };
  }

  await requireCompatibleApp(client);
  const { result, diagnostics } = await runStructureJob<{ workflow: AdminWorkflow; previous: unknown }>(
    client,
    STRUCTURE_APP_METHODS.updateWorkflow,
    request,
  );
  return {
    updated: true,
    workflow: annotate(result.workflow),
    previous: result.previous,
    ...(diagnostics ? { vault_app: diagnostics } : {}),
  };
}

// ---------------------------------------------------------------------------
// Event handlers

export interface AdminEventHandler {
  guid: string;
  position: number;
  event_type: string;
  event_type_id: number;
  name: string;
  active: boolean;
  /** The vault app that generated this stub handler ("DO NOT MODIFY"), if any. */
  generated_by_app?: string | null;
  script: string;
}

function normalizeGuid(guid: string): string {
  return guid.trim().replace(/^\{|\}$/g, "").toUpperCase();
}

function sameEventType(handler: AdminEventHandler, type: string): boolean {
  const t = type.trim().toLowerCase().replace(/^mfeventhandler/, "");
  return handler.event_type.toLowerCase() === t || String(handler.event_type_id) === t;
}

async function readEventHandlers(client: MFilesClient) {
  return readAdminDefinition<{ count: number; handlers: AdminEventHandler[] }>(client, "event_handlers");
}

export async function listEventHandlers(
  client: MFilesClient,
  opts: { eventType?: string; name?: string; includeScripts: boolean; includeAppGenerated?: boolean },
) {
  const { handlers } = await readEventHandlers(client);
  const generated = handlers.filter((h) => h.generated_by_app).length;
  const filtered = handlers.filter(
    (h) =>
      (opts.includeAppGenerated || !h.generated_by_app) &&
      (!opts.eventType || sameEventType(h, opts.eventType)) &&
      (!opts.name || h.name.toLowerCase().includes(opts.name.trim().toLowerCase())),
  );
  return {
    total: handlers.length,
    shown: filtered.length,
    ...(generated && !opts.includeAppGenerated
      ? { hidden_app_generated: generated }
      : {}),
    handlers: filtered.map((h) =>
      opts.includeScripts
        ? h
        : { ...h, script: undefined, script_lines: h.script ? h.script.split(/\r?\n/).length : 0 },
    ),
    ...(opts.includeScripts
      ? {}
      : { _hint: "Scripts left out; pass include_scripts=true (and a filter) to see them." }),
  };
}

export interface SetEventHandlerArgs {
  guid?: string;
  eventType?: string;
  name?: string;
  script?: string;
  active?: boolean;
  createNew: boolean;
  dryRun: boolean;
}

/**
 * Add a VBScript event handler or change one. Without a GUID, an existing
 * handler with the same event type and name is changed rather than
 * duplicated, unless create_new is set.
 */
export async function setEventHandler(client: MFilesClient, args: SetEventHandlerArgs) {
  const { handlers } = await readEventHandlers(client);
  let target: AdminEventHandler | undefined;
  if (args.guid) {
    target = handlers.find((h) => normalizeGuid(h.guid) === normalizeGuid(args.guid!));
    if (!target) {
      throw new MFilesToolError(`There's no event handler with GUID ${args.guid}.`, "List them with mfiles_list_event_handlers.");
    }
    if (target.generated_by_app) {
      throw new MFilesToolError(
        `Event handler ${target.guid} ("${target.name}") is a stub that M-Files generated for vault application ${target.generated_by_app}; its script says DO NOT MODIFY.`,
        "Change the vault application instead, or pick another handler.",
      );
    }
  } else if (!args.createNew && args.eventType && args.name !== undefined) {
    const same = handlers.filter(
      (h) => !h.generated_by_app && sameEventType(h, args.eventType!) && sameName(h.name, args.name!),
    );
    if (same.length > 1) {
      throw new MFilesToolError(
        `${same.length} ${args.eventType} handlers are named "${args.name}": ${same.map((h) => h.guid).join(", ")}.`,
        "Pass the guid of the one to change, or create_new=true to add another.",
      );
    }
    target = same[0];
  }
  if (!target && (!args.eventType || !args.script?.trim())) {
    throw new MFilesToolError(
      "A new event handler needs event_type and script.",
      "Pass event_type (e.g. BeforeCheckInChanges, VaultExtensionMethod) and the VBScript, or a guid to change an existing handler.",
    );
  }

  const changes: Record<string, unknown> = {};
  if (target) {
    if (args.eventType !== undefined && !sameEventType(target, args.eventType)) changes.event_type = { from: target.event_type, to: args.eventType };
    if (args.name !== undefined && args.name !== target.name) changes.name = { from: target.name, to: args.name };
    if (args.active !== undefined && args.active !== target.active) changes.active = { from: target.active, to: args.active };
    if (args.script !== undefined && args.script !== target.script) {
      changes.script = { from_lines: target.script.split(/\r?\n/).length, to_lines: args.script.split(/\r?\n/).length };
    }
    if (Object.keys(changes).length === 0) {
      return { updated: false, handler: target, _hint: "The handler already looks like this; nothing to do." };
    }
  }
  const plan = target
    ? { action: "update", handler: { guid: target.guid, event_type: target.event_type, name: target.name }, changes }
    : { action: "create", handler: { event_type: args.eventType, name: args.name ?? "", active: args.active ?? true, script_lines: args.script!.split(/\r?\n/).length } };
  if (args.dryRun) {
    return {
      dry_run: true,
      ...plan,
      ...(target && args.script !== undefined ? { current_script: target.script } : {}),
      _hint: "Nothing was written. Call again with dry_run=false to apply.",
    };
  }

  const { result, diagnostics } = await runStructureJob<{
    created: boolean;
    handler: AdminEventHandler;
    previous: AdminEventHandler | null;
    count: number;
  }>(client, STRUCTURE_APP_METHODS.setEventHandler, {
    ...(target ? { guid: target.guid } : {}),
    ...(args.eventType !== undefined ? { event_type: args.eventType } : {}),
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.script !== undefined ? { script: args.script } : {}),
    ...(args.active !== undefined ? { active: args.active } : {}),
    expected_guids: handlers.map((h) => h.guid),
  });
  return {
    ...(result.created ? { created: true } : { updated: true }),
    handler: result.handler,
    ...(result.previous ? { previous: result.previous } : {}),
    ...(diagnostics ? { vault_app: diagnostics } : {}),
  };
}

// ---------------------------------------------------------------------------
// Property definitions: name, aliases, calculated values, validation

export const AUTOMATIC_VALUE_TYPES = [
  "none",
  "calculated",
  "calculated_vbscript",
  "auto_number",
  "auto_number_vbscript",
] as const;

export interface AutomaticValueInput {
  type: (typeof AUTOMATIC_VALUE_TYPES)[number];
  expression?: string;
  script?: string;
  increment?: number;
  calculationOrder?: number;
}

export interface ValidationInput {
  type: "none" | "regex" | "vbscript";
  regex?: string;
  script?: string;
}

export interface UpdatePropertyDefArgs {
  property: PropertyRef;
  rename?: string;
  addAliases: string[];
  removeAliases: string[];
  automaticValue?: AutomaticValueInput;
  validation?: ValidationInput;
  recalculate: "none" | "empty_only" | "all";
  dryRun: boolean;
}

export async function updatePropertyDef(client: MFilesClient, args: UpdatePropertyDefArgs) {
  const [def] = await resolvePropertyDefs(client, [args.property]);
  const av = args.automaticValue;
  if (av?.type === "calculated" && !av.expression?.trim()) {
    throw new MFilesToolError("automatic_value type \"calculated\" needs expression.", "Pass the placeholder expression, e.g. \"%PROPERTY_0% (%PROPERTY_1020%)\".");
  }
  if ((av?.type === "calculated_vbscript" || av?.type === "auto_number_vbscript") && !av.script?.trim()) {
    throw new MFilesToolError(`automatic_value type "${av.type}" needs script.`, "Pass the VBScript; it sets Output.");
  }
  const v = args.validation;
  if (v?.type === "regex" && !v.regex?.trim()) {
    throw new MFilesToolError("validation type \"regex\" needs regex.", "Pass the regular expression values must match.");
  }
  if (v?.type === "vbscript" && !v.script?.trim()) {
    throw new MFilesToolError("validation type \"vbscript\" needs script.", "Pass the VBScript; it raises an error to reject a value.");
  }
  if (args.rename !== undefined) {
    if (!args.rename.trim()) throw new MFilesToolError("rename is empty.", "Pass the new name, or leave rename out.");
    const clash = (await client.listProperties()).filter((p) => p.ID !== def.ID && sameName(p.Name, args.rename!));
    if (clash.length) {
      throw new MFilesToolError(
        `Another property is already named "${args.rename.trim()}": ${clash.map((p) => p.ID).join(", ")}.`,
        "Pick another name.",
      );
    }
  }
  const changed =
    args.rename !== undefined ||
    args.addAliases.length > 0 ||
    args.removeAliases.length > 0 ||
    av !== undefined ||
    v !== undefined ||
    args.recalculate !== "none";
  if (!changed) {
    throw new MFilesToolError("Nothing to change.", "Pass rename, add_aliases, remove_aliases, automatic_value, validation or recalculate.");
  }

  const request = {
    property_id: def.ID,
    expected: {
      name: def.Name,
      data_type: def.DataType,
      ...(isLookupDataType(def.DataType) && typeof def.ValueList === "number" ? { value_list: def.ValueList } : {}),
    },
    ...(args.rename !== undefined ? { name: args.rename.trim() } : {}),
    ...(args.addAliases.length ? { add_aliases: args.addAliases } : {}),
    ...(args.removeAliases.length ? { remove_aliases: args.removeAliases } : {}),
    ...(av
      ? {
          automatic_value: {
            type: av.type,
            ...(av.expression !== undefined ? { expression: av.expression } : {}),
            ...(av.script !== undefined ? { script: av.script } : {}),
            ...(av.increment !== undefined ? { increment: av.increment } : {}),
            ...(av.calculationOrder !== undefined ? { calculation_order: av.calculationOrder } : {}),
          },
        }
      : {}),
    ...(v
      ? {
          validation: {
            type: v.type,
            ...(v.regex !== undefined ? { regex: v.regex } : {}),
            ...(v.script !== undefined ? { script: v.script } : {}),
          },
        }
      : {}),
    recalculate: args.recalculate,
  };

  if (args.dryRun) {
    return {
      dry_run: true,
      property: { id: def.ID, name: def.Name },
      current: await readAdminDefinition(client, "property_def", def.ID),
      changes: request,
      _hint: "Nothing was written. Call again with dry_run=false to apply.",
    };
  }

  await requireCompatibleApp(client);
  const { result, diagnostics } = await runStructureJob<{ property_def: unknown; before: unknown }>(
    client,
    STRUCTURE_APP_METHODS.updatePropertyDef,
    request,
  );
  return {
    updated: true,
    property_def: result.property_def,
    before: result.before,
    ...(diagnostics ? { vault_app: diagnostics } : {}),
  };
}
