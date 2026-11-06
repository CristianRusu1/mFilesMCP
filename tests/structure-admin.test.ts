import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { STRUCTURE_APP_METHODS, setJobPollDelaysForTests } from "../src/structure-app.js";
import {
  createWorkflow,
  listEventHandlers,
  setEventHandler,
  updatePropertyDef,
  updateWorkflow,
} from "../src/structure-admin.js";
import type { AdminEventHandler, AdminWorkflow } from "../src/structure-admin.js";
import { MFDataType, MFilesToolError } from "../src/types.js";
import { connect } from "./helpers.js";
import { PING_OK, ext, jobDone, useStructureEnv } from "./structure-helpers.js";
import type { Route } from "./helpers.js";

before(() => setJobPollDelaysForTests([0]));
after(() => setJobPollDelaysForTests(null));
useStructureEnv();

// Fixture IDs are arbitrary test data.
const WORKFLOW = { ID: 55, Name: "Approval", ObjectClass: 0 };
const STATES = [
  { ID: 101, Name: "Draft", Selectable: true },
  { ID: 102, Name: "Approved", Selectable: true },
];
const ADMIN_WORKFLOW: AdminWorkflow = {
  id: 55,
  name: "Approval",
  aliases: [],
  states: [
    { id: 101, name: "Draft", aliases: [], run_script: false, actions: [], restrict_transitions: false },
    { id: 102, name: "Approved", aliases: [], run_script: true, script: "' notify", actions: ["run_script"], restrict_transitions: false },
  ],
  transitions: [
    { id: 900, from_state: 101, to_state: 102, trigger: "none", evaluation_order: 1, aliases: [] },
  ],
};

function body(calls: Array<{ path: string; body?: string }>, method: string) {
  const call = calls.find((c) => c.path === ext(method));
  assert.ok(call, `no call to ${method}`);
  return JSON.parse(call.body!);
}

const workflowRoutes = (extra: Route[] = []): Route[] => [
  PING_OK,
  { path: "/REST/structure/workflows.aspx", json: [WORKFLOW, { ID: 56, Name: "Review" }] },
  { path: "/REST/structure/workflows/55.aspx", json: WORKFLOW },
  { path: "/REST/structure/workflows/55/states.aspx", json: STATES },
  ...extra,
];

describe("createWorkflow", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  it("sends states and name-based transitions", async () => {
    const mock = await connect(
      workflowRoutes([
        { method: "POST", path: ext(STRUCTURE_APP_METHODS.createWorkflow), text: jobDone({ ...ADMIN_WORKFLOW, id: 60, name: "Lease" }) },
      ]),
    );
    restore = mock.restore;
    const result = await createWorkflow(mock.client, {
      name: "Lease",
      aliases: [],
      states: [{ name: "Draft" }, { name: "Approved", script: "' notify" }],
      transitions: [{ from: "draft", to: "Approved", trigger: { mode: "script", script: "AllowStateTransition = True" } }],
      allowDuplicateName: false,
      dryRun: false,
    });
    const sent = body(mock.calls, STRUCTURE_APP_METHODS.createWorkflow);
    assert.deepEqual(sent.states, [{ name: "Draft" }, { name: "Approved", script: "' notify" }]);
    assert.deepEqual(sent.transitions, [
      { from_state_name: "draft", to_state_name: "Approved", trigger: { mode: "script", script: "AllowStateTransition = True" } },
    ]);
    const transitions = (result as { workflow: { transitions: Array<{ from_state_name: string }> } }).workflow.transitions;
    assert.equal(transitions[0].from_state_name, "Draft");
  });

  it("refuses unknown state names, duplicate states and duplicate workflow names", async () => {
    const mock = await connect(workflowRoutes());
    restore = mock.restore;
    const base = { aliases: [], transitions: [], allowDuplicateName: false, dryRun: true };
    await assert.rejects(
      () => createWorkflow(mock.client, { ...base, name: "X", states: [{ name: "A" }], transitions: [{ from: "A", to: "B" }] }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("transitions[0].to"),
    );
    await assert.rejects(
      () => createWorkflow(mock.client, { ...base, name: "X", states: [{ name: "A" }, { name: " a " }] }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("already a state"),
    );
    await assert.rejects(
      () => createWorkflow(mock.client, { ...base, name: "approval", states: [{ name: "A" }] }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("already exists"),
    );
    await assert.rejects(
      () => createWorkflow(mock.client, { ...base, name: "X", states: [{ name: "A" }], transitions: [{ from: "A", to: "A", trigger: { mode: "script" } }] }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("trigger.script"),
    );
  });
});

describe("updateWorkflow", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  const noChanges = {
    addStates: [],
    updateStates: [],
    addTransitions: [],
    updateTransitions: [],
    removeTransitions: [],
    dryRun: false,
  };

  it("resolves names, sends REST's states for the guard and returns the previous version", async () => {
    const mock = await connect(
      workflowRoutes([
        {
          method: "POST",
          path: ext(STRUCTURE_APP_METHODS.updateWorkflow),
          text: jobDone({ workflow: ADMIN_WORKFLOW, previous: { states: [{ id: 102, script: null }], transitions: [] } }),
        },
      ]),
    );
    restore = mock.restore;
    const result = await updateWorkflow(mock.client, {
      ...noChanges,
      workflow: "approval",
      addStates: [{ name: "Rejected" }],
      updateStates: [{ state: "Approved", script: "' notify" }],
      addTransitions: [
        { from: "Draft", to: "Rejected" },
        { from: 102, to: "Draft", trigger: { mode: "days", days: 30 } },
      ],
      removeTransitions: [900, 900],
    });
    const sent = body(mock.calls, STRUCTURE_APP_METHODS.updateWorkflow);
    assert.equal(sent.workflow_id, 55);
    assert.deepEqual(sent.expected, { name: "Approval", states: [101, 102] });
    assert.deepEqual(sent.update_states, [{ id: 102, script: "' notify" }]);
    assert.deepEqual(sent.add_transitions, [
      { from_state: 101, to_state_name: "Rejected" },
      { from_state: 102, to_state: 101, trigger: { mode: "days", days: 30 } },
    ]);
    assert.deepEqual(sent.remove_transitions, [900]);
    assert.ok((result as { previous: unknown }).previous);
  });

  it("refuses unknown states and empty updates", async () => {
    const mock = await connect(workflowRoutes());
    restore = mock.restore;
    await assert.rejects(
      () => updateWorkflow(mock.client, { ...noChanges, workflow: 55, updateStates: [{ state: "Archived", rename: "Old" }] }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("no state named \"Archived\"") && err.hint.includes("101 \"Draft\""),
    );
    await assert.rejects(
      () => updateWorkflow(mock.client, { ...noChanges, workflow: 55 }),
      (err: unknown) => err instanceof MFilesToolError && err.message === "Nothing to change.",
    );
  });

  it("dry run shows the current version of what it would touch", async () => {
    const mock = await connect(
      workflowRoutes([{ method: "POST", path: ext(STRUCTURE_APP_METHODS.read), text: jobDone(ADMIN_WORKFLOW) }]),
    );
    restore = mock.restore;
    const result = await updateWorkflow(mock.client, {
      ...noChanges,
      workflow: 55,
      updateTransitions: [{ id: 900, trigger: { mode: "assignment_complete" } }],
      dryRun: true,
    });
    const current = (result as { current: { transitions: Array<{ id: number; to_state_name: string }> } }).current;
    assert.deepEqual(current.transitions.map((t) => [t.id, t.to_state_name]), [[900, "Approved"]]);
    assert.ok(!mock.calls.some((c) => c.path === ext(STRUCTURE_APP_METHODS.updateWorkflow)));
    await assert.rejects(
      () => updateWorkflow(mock.client, { ...noChanges, workflow: 55, removeTransitions: [999], dryRun: true }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("no transition 999"),
    );
  });
});

const HANDLERS: AdminEventHandler[] = [
  { guid: "{AAAA}", position: 1, event_type: "BeforeCheckInChanges", event_type_id: 4, name: "Validate", active: true, script: "' a\n' b" },
  { guid: "{BBBB}", position: 2, event_type: "VaultExtensionMethod", event_type_id: 35, name: "DoThing", active: true, script: "Output = 1" },
  {
    guid: "{CCCC}",
    position: 3,
    event_type: "VaultExtensionMethod",
    event_type_id: 35,
    name: "Acme_Method",
    active: true,
    generated_by_app: "a87388a0-5c06-4fca-a858-8209f27bfdad",
    script: "' GENERATED_SCRIPT_START_a87388a0-5c06-4fca-a858-8209f27bfdad\n' DO NOT MODIFY!",
  },
];

describe("event handlers", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  const routes = (extra: Route[] = []): Route[] => [
    PING_OK,
    { method: "POST", path: ext(STRUCTURE_APP_METHODS.read), text: jobDone({ count: 3, handlers: HANDLERS }) },
    ...extra,
  ];

  it("lists without scripts unless asked, filtered by type", async () => {
    const mock = await connect(routes());
    restore = mock.restore;
    const list = await listEventHandlers(mock.client, { eventType: "vaultextensionmethod", includeScripts: false });
    assert.equal(list.shown, 1);
    assert.equal((list as { hidden_app_generated: number }).hidden_app_generated, 1);
    const all = await listEventHandlers(mock.client, { eventType: "vaultextensionmethod", includeScripts: false, includeAppGenerated: true });
    assert.equal(all.shown, 2);
    assert.equal((list.handlers[0] as { script?: string }).script, undefined);
    assert.equal((list.handlers[0] as { script_lines: number }).script_lines, 1);
    assert.deepEqual(JSON.parse(mock.calls.find((c) => c.path === ext(STRUCTURE_APP_METHODS.read))!.body!), { kind: "event_handlers" });
  });

  it("changes the handler with the same type and name instead of adding a duplicate", async () => {
    const mock = await connect(
      routes([
        {
          method: "POST",
          path: ext(STRUCTURE_APP_METHODS.setEventHandler),
          text: jobDone({ created: false, handler: { ...HANDLERS[0], script: "' c" }, previous: HANDLERS[0], count: 2 }),
        },
      ]),
    );
    restore = mock.restore;
    const result = await setEventHandler(mock.client, {
      eventType: "BeforeCheckInChanges",
      name: "validate",
      script: "' c",
      createNew: false,
      dryRun: false,
    });
    const sent = body(mock.calls, STRUCTURE_APP_METHODS.setEventHandler);
    assert.equal(sent.guid, "{AAAA}");
    assert.deepEqual(sent.expected_guids, ["{AAAA}", "{BBBB}", "{CCCC}"]);
    assert.equal((result as { updated: boolean }).updated, true);
    assert.ok((result as { previous: unknown }).previous);
  });

  it("needs event_type and script for a new handler, and does nothing when nothing changes", async () => {
    const mock = await connect(routes());
    restore = mock.restore;
    await assert.rejects(
      () => setEventHandler(mock.client, { name: "New", createNew: true, dryRun: true }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("event_type and script"),
    );
    await assert.rejects(
      () => setEventHandler(mock.client, { guid: "{CCCC}", active: false, createNew: false, dryRun: true }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("DO NOT MODIFY"),
    );
    const same = await setEventHandler(mock.client, { guid: "bbbb", script: "Output = 1", createNew: false, dryRun: false });
    assert.equal((same as { updated: boolean }).updated, false);
    assert.ok(!mock.calls.some((c) => c.path === ext(STRUCTURE_APP_METHODS.setEventHandler)));
  });
});

describe("updatePropertyDef", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  const routes = (extra: Route[] = []): Route[] => [
    PING_OK,
    { path: "/REST/structure/properties.aspx", json: [{ ID: 1001, Name: "Batch Number", DataType: MFDataType.Text }, { ID: 1002, Name: "Lot", DataType: MFDataType.Text }] },
    { path: "/REST/structure/properties/1001.aspx", json: { ID: 1001, Name: "Batch Number", DataType: MFDataType.Text } },
    ...extra,
  ];

  it("sends REST's view for the guard along with the change", async () => {
    const mock = await connect(
      routes([
        {
          method: "POST",
          path: ext(STRUCTURE_APP_METHODS.updatePropertyDef),
          text: jobDone({ property_def: { id: 1001 }, before: { id: 1001 } }),
        },
      ]),
    );
    restore = mock.restore;
    await updatePropertyDef(mock.client, {
      property: "batch number",
      addAliases: ["Acme.Property.Batch"],
      removeAliases: [],
      automaticValue: { type: "calculated_vbscript", script: "Output = \"B-\" & 1" },
      validation: { type: "regex", regex: "^B-" },
      recalculate: "empty_only",
      dryRun: false,
    });
    const sent = body(mock.calls, STRUCTURE_APP_METHODS.updatePropertyDef);
    assert.deepEqual(sent, {
      property_id: 1001,
      expected: { name: "Batch Number", data_type: MFDataType.Text },
      add_aliases: ["Acme.Property.Batch"],
      automatic_value: { type: "calculated_vbscript", script: "Output = \"B-\" & 1" },
      validation: { type: "regex", regex: "^B-" },
      recalculate: "empty_only",
    });
  });

  it("checks that each type has what it needs and that renames don't clash", async () => {
    const mock = await connect(routes());
    restore = mock.restore;
    const base = { property: 1001, addAliases: [], removeAliases: [], recalculate: "none" as const, dryRun: true };
    await assert.rejects(
      () => updatePropertyDef(mock.client, { ...base, automaticValue: { type: "calculated" } }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("expression"),
    );
    await assert.rejects(
      () => updatePropertyDef(mock.client, { ...base, validation: { type: "vbscript" } }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("script"),
    );
    await assert.rejects(
      () => updatePropertyDef(mock.client, { ...base, rename: "lot" }),
      (err: unknown) => err instanceof MFilesToolError && err.message.includes("1002"),
    );
    await assert.rejects(
      () => updatePropertyDef(mock.client, base),
      (err: unknown) => err instanceof MFilesToolError && err.message === "Nothing to change.",
    );
  });
});
