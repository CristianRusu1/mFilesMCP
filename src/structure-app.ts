import type { MFilesClient } from "./mfiles-client.js";
import {
  MFDataType,
  MFUpdateType,
  MFilesRequestError,
  MFilesToolError,
  isLookupDataType,
  resolveDataTypeName,
} from "./types.js";
import type { MFilesClass, MFilesPropertyDef } from "./types.js";

/**
 * Bridge to the companion vault application in vault-app/. The M-Files REST
 * API can read metadata structure but not change it, so structure reads and
 * writes go through vault extension methods that the app exposes.
 *
 * Since protocol 3 every method except ping and getJob queues a job in the
 * app and returns it at once; runStructureJob polls getJob until the job
 * finishes. Structure changes can take minutes on some servers, longer than
 * MCP clients wait for a tool call.
 */

/** Must match the C# constants in vault-app/VaultApplication.cs. */
export const STRUCTURE_APP_METHODS = {
  ping: "MFilesMCP_Ping",
  getJob: "MFilesMCP_GetJob",
  checkAdminSession: "MFilesMCP_CheckAdminSession",
  read: "MFilesMCP_Read",
  createPropertyDef: "MFilesMCP_CreatePropertyDef",
  updatePropertyDef: "MFilesMCP_UpdatePropertyDef",
  createClass: "MFilesMCP_CreateClass",
  updateClass: "MFilesMCP_UpdateClass",
  createValueList: "MFilesMCP_CreateValueList",
  createWorkflow: "MFilesMCP_CreateWorkflow",
  updateWorkflow: "MFilesMCP_UpdateWorkflow",
  setEventHandler: "MFilesMCP_SetEventHandler",
  /** Since app 1.0.11. */
  createObjectType: "MFilesMCP_CreateObjectType",
} as const;

/** Bump together with the C# Protocol constant when the contract changes. */
export const STRUCTURE_APP_PROTOCOL = 3;

const INSTALL_HINT =
  "Install the MFilesMCP vault app (vault-app/README.md) in this vault via M-Files Admin → Applications, then retry.";

const STARTING_HINT =
  "Wait a minute and retry. If it keeps saying this, the app probably failed to start: check its status in M-Files Admin → Applications and the server's Windows event log (source M-Files).";

/** Property data types the structure tools can create. */
export const CREATABLE_DATA_TYPES = {
  Text: MFDataType.Text,
  MultiLineText: MFDataType.MultiLineText,
  Integer: MFDataType.Integer,
  Floating: MFDataType.Floating,
  Date: MFDataType.Date,
  Time: MFDataType.Time,
  Timestamp: MFDataType.Timestamp,
  Boolean: MFDataType.Boolean,
  SingleSelectLookup: MFDataType.Lookup,
  MultiSelectLookup: MFDataType.MultiSelectLookup,
} as const;

export type CreatableDataTypeName = keyof typeof CREATABLE_DATA_TYPES;

/** How the app made a structure change: channel, login, timing. */
export type AppDiagnostics = Record<string, unknown>;

interface AppResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
  diagnostics?: AppDiagnostics;
}

export interface AppResult<T> {
  result: T;
  diagnostics?: AppDiagnostics;
}

/** The app's output may come back raw or JSON-encoded once more by MFWS. */
export function parseAppResponse<T>(raw: string, method: string): AppResult<T> {
  let value: unknown = raw;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  const resp = value as AppResponse<T> | null;
  if (typeof resp !== "object" || resp === null || typeof resp.ok !== "boolean") {
    throw new MFilesToolError(
      `Unexpected response from vault extension method ${method}: ${raw.slice(0, 200)}`,
      `The installed vault app doesn't speak this server's protocol. ${INSTALL_HINT}`,
    );
  }
  if (!resp.ok) {
    throw new MFilesToolError(
      (resp.error ?? `${method} failed without an error message.`) + diagnosticsSuffix(resp.diagnostics),
      "M-Files refused the structure change. Read the error, fix the input and retry.",
    );
  }
  return { result: resp.result as T, diagnostics: resp.diagnostics };
}

function diagnosticsSuffix(diagnostics: AppDiagnostics | null | undefined): string {
  return diagnostics && Object.keys(diagnostics).length
    ? ` Vault app diagnostics: ${JSON.stringify(diagnostics).slice(0, 3000)}`
    : "";
}

function translateTransportError(err: unknown, method: string): unknown {
  if (!(err instanceof MFilesRequestError)) return err;
  const msg = err.serverMessage ?? err.body ?? "";
  // The app catches its own exceptions and answers { ok: false }, so a
  // transport-level failure comes from MFWS or the VAF itself.
  const methodMissing =
    /extension ?method/i.test(msg) &&
    /not (found|registered|available)|unknown|no such|does not exist/i.test(msg);
  if (err.status === 404 || methodMissing) {
    return new MFilesToolError(
      `Vault extension method ${method} is not available in this vault.`,
      INSTALL_HINT,
    );
  }
  if (/still starting up/i.test(msg)) {
    return new MFilesToolError(
      "The MFilesMCP vault app is installed but hasn't finished starting.",
      STARTING_HINT,
    );
  }
  if (
    err.status === 403 ||
    /access denied|permission|not allowed|sufficient (rights|permissions)|vault access/i.test(msg)
  ) {
    return new MFilesToolError(
      `The authenticated user may not change the metadata structure: ${err.serverMessage ?? err.message}`,
      "Structure changes need the 'Change metadata structure' vault right (vault administrators have it). Authenticate as such a user.",
    );
  }
  return err;
}

export async function callStructureApp<T>(
  client: MFilesClient,
  method: string,
  input: unknown,
): Promise<AppResult<T>> {
  let raw: string;
  try {
    raw = await client.executeExtensionMethod(method, JSON.stringify(input));
  } catch (err) {
    throw translateTransportError(err, method);
  }
  return parseAppResponse<T>(raw, method);
}

// ---------------------------------------------------------------------------
// Jobs

export interface StructureJob<T = unknown> {
  job_id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  step?: string | null;
  queued_ms?: number;
  elapsed_ms?: number | null;
  result?: T | null;
  error?: string | null;
  /** "admin_login_failed" when the app couldn't open its admin session. */
  error_code?: string | null;
  diagnostics?: AppDiagnostics | null;
}

/**
 * The job was still running when this server stopped waiting. It isn't a
 * failure: the change may well go through.
 */
export class StructureJobPendingError extends MFilesToolError {
  constructor(
    readonly job: StructureJob,
    extraHint = "",
  ) {
    super(
      `M-Files is still working on this (${job.kind}${job.step ? `: ${job.step}` : ""}; job ${job.job_id}).`,
      `Don't resubmit it. Call mfiles_structure_job with job_id="${job.job_id}" in a minute to get the result.${extraHint ? ` ${extraHint}` : ""}`,
    );
  }
}

const DEFAULT_WAIT_MS = 45_000;
const POLL_DELAYS_MS = [250, 500, 1000, 1500, 2000];
const VERIFY_RETRY_MS = 2000;
let pollDelays = POLL_DELAYS_MS;
let verifyRetryMs = VERIFY_RETRY_MS;

/**
 * Test hook: how long to sleep between polls, and before re-checking a change
 * over REST (null restores the defaults).
 */
export function setJobPollDelaysForTests(delays: number[] | null): void {
  pollDelays = delays ?? POLL_DELAYS_MS;
  verifyRetryMs = delays ? 0 : VERIFY_RETRY_MS;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** How long one tool call waits for a job; MFILES_STRUCTURE_WAIT_SECONDS overrides. */
function waitBudgetMs(): number {
  const seconds = Number(process.env.MFILES_STRUCTURE_WAIT_SECONDS);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_WAIT_MS;
}

export interface StructureLogin {
  username: string;
  password: string;
  domain?: string;
}

/**
 * When to send credentials for the app's admin session
 * (MFILES_STRUCTURE_LOGIN): "auto" (default) sends MFILES_USERNAME and
 * MFILES_PASSWORD only after logging in as the app's Windows account failed,
 * "credentials" always sends them, "windows" never does.
 */
function structureLoginMode(): "auto" | "credentials" | "windows" {
  const mode = (process.env.MFILES_STRUCTURE_LOGIN ?? "").trim().toLowerCase();
  return mode === "credentials" || mode === "windows" ? mode : "auto";
}

function structureLogin(): StructureLogin | undefined {
  const username = process.env.MFILES_USERNAME?.trim();
  const password = process.env.MFILES_PASSWORD;
  if (!username || password === undefined) return undefined;
  const domain = process.env.MFILES_DOMAIN?.trim();
  return { username, password, ...(domain ? { domain } : {}) };
}

/**
 * Where the app should reach the M-Files server, from
 * MFILES_STRUCTURE_SERVER_ENDPOINT ("protocol:address:port", comma-separated).
 * The app defaults to ncacn_ip_tcp localhost:2266.
 */
function serverEndpoints() {
  const raw = process.env.MFILES_STRUCTURE_SERVER_ENDPOINT?.trim();
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [protocol, address, port] = s.split(":");
      return { protocol, address, port };
    });
}

/**
 * Submit a job and wait for it. If the app couldn't open its admin session
 * and credentials are available, resubmit once with them.
 */
export async function runStructureJob<T>(
  client: MFilesClient,
  method: string,
  input: Record<string, unknown>,
): Promise<AppResult<T>> {
  const endpoints = serverEndpoints();
  const base = endpoints ? { ...input, server_endpoints: endpoints } : { ...input };
  const mode = structureLoginMode();
  const available = structureLogin();
  const login = mode === "windows" ? undefined : available;
  let sentLogin = mode === "credentials" && login !== undefined;
  let job = await submitAndWait<T>(client, method, sentLogin ? { ...base, login } : base);
  if (
    job.status === "failed" &&
    job.error_code === "admin_login_failed" &&
    login !== undefined &&
    !sentLogin
  ) {
    sentLogin = true;
    job = await submitAndWait<T>(client, method, { ...base, login });
  }
  return finishJob(job, sentLogin, available !== undefined);
}

async function submitAndWait<T>(
  client: MFilesClient,
  method: string,
  payload: Record<string, unknown>,
): Promise<StructureJob<T>> {
  const { result: job } = await callStructureApp<StructureJob<T>>(client, method, payload);
  return waitForJob(client, job, waitBudgetMs());
}

async function waitForJob<T>(
  client: MFilesClient,
  job: StructureJob<T>,
  budgetMs: number,
): Promise<StructureJob<T>> {
  const deadline = Date.now() + budgetMs;
  let current = job;
  for (let attempt = 0; current.status === "queued" || current.status === "running"; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const delay = Math.min(pollDelays[Math.min(attempt, pollDelays.length - 1)], remaining);
    await sleep(delay);
    current = (
      await callStructureApp<StructureJob<T>>(client, STRUCTURE_APP_METHODS.getJob, {
        job_id: current.job_id,
      })
    ).result;
  }
  return current;
}

function finishJob<T>(job: StructureJob<T>, sentLogin: boolean, haveLogin: boolean): AppResult<T> {
  if (job.status === "succeeded") {
    return { result: job.result as T, diagnostics: job.diagnostics ?? undefined };
  }
  if (job.status === "failed") {
    throw new MFilesToolError(
      (job.error ?? `${job.kind} failed without an error message.`) + diagnosticsSuffix(job.diagnostics),
      job.error_code === "admin_login_failed"
        ? adminLoginHint(sentLogin, haveLogin)
        : "M-Files refused the change. Read the error, fix the input and retry.",
    );
  }
  throw new StructureJobPendingError(job);
}

function adminLoginHint(sentLogin: boolean, haveLogin: boolean): string {
  if (sentLogin) {
    return "The vault app couldn't log in to the M-Files server, neither as its Windows account nor with MFILES_USERNAME/MFILES_PASSWORD; the error lists every attempt. If the server's RPC endpoint isn't ncacn_ip_tcp localhost:2266, set MFILES_STRUCTURE_SERVER_ENDPOINT (e.g. \"ncacn_ip_tcp:localhost:2266\") in this server's env.";
  }
  return haveLogin
    ? "The vault app couldn't log in to the M-Files server as its Windows account, and MFILES_STRUCTURE_LOGIN=windows stops this server from sending MFILES_USERNAME/MFILES_PASSWORD instead."
    : "The vault app couldn't log in to the M-Files server as its Windows account. Put a vault administrator's MFILES_USERNAME/MFILES_PASSWORD in this server's env so it can log in with those.";
}

/** The current state of a job, for jobs that outlived the tool call that started them. */
export async function getStructureJob(client: MFilesClient, jobId: string) {
  const { result: job } = await callStructureApp<StructureJob>(
    client,
    STRUCTURE_APP_METHODS.getJob,
    { job_id: jobId },
  );
  return job.status === "queued" || job.status === "running"
    ? { ...job, _hint: "Still running. Check again in a minute; don't resubmit the change." }
    : job;
}

// ---------------------------------------------------------------------------
// Status

export interface PingResult {
  app: string;
  version: string;
  protocol: number;
  /** Since app 1.0.2: whether the app holds the vault reference it needs. */
  vault_ready?: boolean;
  /** Since app 1.0.2: what failed while the VAF started the app, if anything. */
  startup_error?: string | null;
  /** Since app 1.0.7: the Windows account the app runs as. */
  process_identity?: string;
  /** Since app 1.0.7: the admin session's last known state. */
  admin_session?: Record<string, unknown>;
  /** Since app 1.0.7. */
  jobs?: Record<string, unknown>;
  /** Since app 1.0.11: every extension method the installed build has. */
  methods?: string[];
}

export async function pingStructureApp(client: MFilesClient) {
  try {
    const { result: r } = await callStructureApp<PingResult>(
      client,
      STRUCTURE_APP_METHODS.ping,
      {},
    );
    const compatible = r.protocol === STRUCTURE_APP_PROTOCOL;
    const hint = !compatible
      ? `This server speaks protocol ${STRUCTURE_APP_PROTOCOL} but the vault app speaks ${r.protocol}. Install the vault app build that ships with this server (vault-app/bin/Release/MFilesMCP.VaultApp.mfappx).`
      : r.vault_ready === false
        ? "The app is running but has no vault connection, so structure changes will fail. startup_error says why."
        : r.startup_error
          ? "Part of the VAF startup failed (see startup_error), but the app is running and structure changes should work."
          : undefined;
    return {
      installed: true,
      ready: true,
      app: r.app,
      app_version: r.version,
      protocol: r.protocol,
      compatible,
      ...(r.vault_ready !== undefined ? { vault_ready: r.vault_ready } : {}),
      ...(r.startup_error ? { startup_error: r.startup_error } : {}),
      ...(r.process_identity ? { process_identity: r.process_identity } : {}),
      ...(r.jobs ? { jobs: r.jobs } : {}),
      ...(r.methods ? { methods: r.methods } : {}),
      ...(hint ? { _hint: hint } : {}),
    };
  } catch (err) {
    if (err instanceof MFilesToolError && err.hint === INSTALL_HINT) {
      return { installed: false, _hint: INSTALL_HINT };
    }
    if (err instanceof MFilesToolError && err.hint === STARTING_HINT) {
      return { installed: true, ready: false, _hint: STARTING_HINT };
    }
    throw err;
  }
}

interface AdminSessionCheck {
  admin_session: { ok: boolean; login?: string | null; account?: string | null; error?: string | null };
  process_identity?: string;
  class_reads?: string[] | null;
}

/**
 * Ping the app, then have it open (or reuse) its admin session, so the
 * answer says whether changes that read before they write will work.
 * With verifyClassId, also compare every way the app can read that class
 * with the class as REST shows it.
 */
export async function structureAppStatus(
  client: MFilesClient,
  opts: { verifyClassId?: number } = {},
) {
  const status = await pingStructureApp(client);
  if (!status.installed || !("compatible" in status) || !status.compatible) return status;

  let adminSession: Record<string, unknown>;
  try {
    const { result } = await runStructureJob<AdminSessionCheck>(
      client,
      STRUCTURE_APP_METHODS.checkAdminSession,
      {},
    );
    adminSession = result.admin_session;
  } catch (err) {
    if (err instanceof StructureJobPendingError) throw err;
    adminSession = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof MFilesToolError ? { hint: err.hint } : {}),
    };
  }

  let classReads: string[] | null | undefined;
  if (opts.verifyClassId !== undefined) {
    const cls = await client.getClass(opts.verifyClassId);
    const { result } = await runStructureJob<AdminSessionCheck>(
      client,
      STRUCTURE_APP_METHODS.checkAdminSession,
      { class_id: cls.ID, expected: await expectedClassState(client, cls) },
    );
    classReads = result.class_reads;
  }

  const sessionOk = adminSession.ok === true;
  return {
    ...status,
    admin_session: adminSession,
    ...(classReads ? { class_reads: classReads } : {}),
    _hint: sessionOk
      ? "Ready. Structure reads and changes go through the app's admin session, the same kind of session M-Files Admin uses."
      : "The app can create structure but can't open its admin session, so class, workflow, event handler and property updates will be refused. admin_session.error says why.",
  };
}

type AppStatus = Awaited<ReturnType<typeof pingStructureApp>>;

const checkedApps = new WeakMap<MFilesClient, Promise<AppStatus>>();

/**
 * Structure tools need the vault app speaking this server's protocol: an
 * older app would ignore fields it doesn't know, such as the stale-read guard
 * on class updates. Checked once per session.
 */
export async function requireCompatibleApp(client: MFilesClient): Promise<AppStatus> {
  let check = checkedApps.get(client);
  if (!check) {
    check = (async () => {
      const status = await pingStructureApp(client);
      if (!status.installed) throw new MFilesToolError("The MFilesMCP vault app is not installed in this vault.", INSTALL_HINT);
      if ("ready" in status && status.ready === false) throw new MFilesToolError("The MFilesMCP vault app hasn't finished starting.", STARTING_HINT);
      if ("compatible" in status && !status.compatible) {
        throw new MFilesToolError(
          `The vault app speaks protocol ${status.protocol}, this server needs ${STRUCTURE_APP_PROTOCOL}.`,
          `Install the vault app build that ships with this server (vault-app/bin/Release/MFilesMCP.VaultApp.mfappx), then retry.`,
        );
      }
      return status;
    })();
    checkedApps.set(client, check);
    check.catch(() => checkedApps.delete(client));
  }
  return check;
}

/**
 * Methods added after protocol 3 don't bump the protocol, so older apps keep
 * serving every tool they can. A tool that needs a newer method checks Ping's
 * list of methods (app 1.0.11+), pinging again in case the app was upgraded
 * since the cached check.
 */
export async function requireAppMethod(client: MFilesClient, method: string, since: string): Promise<void> {
  const has = (status: AppStatus) =>
    "methods" in status && Array.isArray(status.methods) && status.methods.includes(method);
  if (has(await requireCompatibleApp(client))) return;
  checkedApps.delete(client);
  const fresh = await requireCompatibleApp(client);
  if (has(fresh)) return;
  throw new MFilesToolError(
    `The vault app installed in this vault (${"app_version" in fresh ? fresh.app_version : "unknown version"}) can't do this: it has no ${method}.`,
    `Install vault app ${since} or later (vault-app/bin/Release/MFilesMCP.VaultApp.mfappx) in this vault and restart it; every other structure tool keeps working until then.`,
  );
}

export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Classes

/** A class as the app's admin session reads it. */
export interface AdminClass {
  id: number;
  name: string;
  object_type: number;
  name_property_def: number;
  workflow: number | null;
  force_workflow: boolean;
  predefined: boolean;
  aliases: string[];
  associated_property_defs: Array<{ property_id: number; required: boolean }>;
}

interface ClassUpdateResult {
  class: AdminClass;
  before: AdminClass;
  /** Set when the app couldn't confirm the save itself; REST is checked next. */
  warning?: string | null;
}

/** Whether the class forces its workflow; MFWS calls the flag HasForcedWorkflow. */
function forcedWorkflow(cls: MFilesClass): boolean | undefined {
  return cls.ForcedWorkflow ?? cls.HasForcedWorkflow;
}

/**
 * The class as the REST API shows it now, for the app's stale-read guard.
 * Only user-settable properties are listed; M-Files manages the built-ins.
 */
async function expectedClassState(client: MFilesClient, cls: MFilesClass) {
  const ids = (cls.AssociatedPropertyDefs ?? []).map((a) => a.PropertyDef);
  const defs = await Promise.all(ids.map((id) => client.getProperty(id)));
  return {
    name: cls.Name,
    ...(typeof cls.NamePropertyDef === "number" ? { name_property_def: cls.NamePropertyDef } : {}),
    ...(typeof cls.Workflow === "number" ? { workflow: cls.Workflow } : {}),
    ...(typeof forcedWorkflow(cls) === "boolean" ? { force_workflow: forcedWorkflow(cls) } : {}),
    associations: defs
      .filter((d) => (d.UpdateType ?? MFUpdateType.Normal) === MFUpdateType.Normal)
      .map((d) => d.ID),
  };
}

interface ClassChange {
  add: Array<{ propertyId: number; required: boolean }>;
  remove: number[];
  rename?: string;
  /** 0 removes the workflow. */
  workflowId?: number;
  forceWorkflow?: boolean;
  namePropertyId?: number;
}

function submitClassUpdate(client: MFilesClient, cls: MFilesClass, change: ClassChange, expected: unknown) {
  return runStructureJob<ClassUpdateResult>(client, STRUCTURE_APP_METHODS.updateClass, {
    class_id: cls.ID,
    expected,
    add: change.add.map((a) => ({ property_id: a.propertyId, required: a.required })),
    remove: change.remove,
    ...(change.rename !== undefined ? { name: change.rename } : {}),
    ...(change.workflowId !== undefined ? { workflow: change.workflowId } : {}),
    ...(change.forceWorkflow !== undefined ? { force_workflow: change.forceWorkflow } : {}),
    ...(change.namePropertyId !== undefined ? { name_property_def: change.namePropertyId } : {}),
  });
}

export interface CreatePropertyDefArgs {
  name: string;
  dataType: CreatableDataTypeName;
  valueListId?: number;
  definedForObjectTypeId?: number;
  allObjectTypes?: boolean;
  aliases: string[];
  addToClasses: Array<{ classId: number; required: boolean }>;
  allowDuplicateName: boolean;
  dryRun: boolean;
}

interface CreatedPropertyDef {
  id: number;
  name: string;
  data_type: number;
  value_list?: number;
  object_type?: number;
  all_object_types?: boolean;
}

/**
 * Create a property definition and optionally associate it with classes in
 * the same call. Input is validated against the live structure first so the
 * vault app only sees requests that have a reasonable chance to succeed.
 */
export async function createPropertyDef(
  client: MFilesClient,
  args: CreatePropertyDefArgs,
) {
  const name = args.name.trim();
  if (!name) {
    throw new MFilesToolError("The property name is empty.", "Pass a non-blank name.");
  }
  const dataType = CREATABLE_DATA_TYPES[args.dataType];
  const lookup = isLookupDataType(dataType);
  if (lookup && args.valueListId === undefined) {
    throw new MFilesToolError(
      `${args.dataType} properties need a value_list_id.`,
      "Pass the value list (or object type) the lookup draws from. Find it with mfiles_find_by_name kind=\"value_list\", or create one with mfiles_create_value_list.",
    );
  }
  if (!lookup && args.valueListId !== undefined) {
    throw new MFilesToolError(
      `value_list_id only applies to lookup properties, not ${args.dataType}.`,
      "Drop value_list_id, or use data_type SingleSelectLookup / MultiSelectLookup.",
    );
  }
  if (args.allObjectTypes && args.definedForObjectTypeId !== undefined) {
    throw new MFilesToolError(
      "Pass either defined_for_object_type_id or all_object_types, not both.",
      "all_object_types=true makes the property usable with every object type.",
    );
  }
  const classIds = args.addToClasses.map((c) => c.classId);
  if (new Set(classIds).size !== classIds.length) {
    throw new MFilesToolError(
      "A class appears more than once in add_to_classes.",
      "List each class once.",
    );
  }

  const [existing, valueList, classes] = await Promise.all([
    client.listProperties(),
    args.valueListId !== undefined
      ? client.getValueList(args.valueListId)
      : undefined,
    Promise.all(args.addToClasses.map((c) => client.getClass(c.classId))),
  ]);
  const duplicates = existing.filter((p) => sameName(p.Name, name));
  if (duplicates.length > 0 && !args.allowDuplicateName) {
    throw new MFilesToolError(
      `A property definition named "${name}" already exists: ${duplicates.map((p) => `${p.ID}`).join(", ")}.`,
      "Reuse it (mfiles_update_class adds it to classes), pick another name, or pass allow_duplicate_name=true.",
    );
  }

  const classObjectTypes = [...new Set(classes.map((c) => c.ObjectType))];
  let allObjectTypes = args.allObjectTypes ?? false;
  let objectType = args.definedForObjectTypeId;
  if (!allObjectTypes && objectType === undefined) {
    if (classObjectTypes.length === 1) objectType = classObjectTypes[0];
    else if (classObjectTypes.length > 1) allObjectTypes = true;
    else {
      throw new MFilesToolError(
        "Can't tell which object type the property is for.",
        "Pass defined_for_object_type_id (see mfiles_list_object_types), all_object_types=true, or add_to_classes so it can be inferred.",
      );
    }
  }
  if (!allObjectTypes && objectType !== undefined) {
    const mismatched = classes.filter((c) => c.ObjectType !== objectType);
    if (mismatched.length > 0) {
      throw new MFilesToolError(
        `The property would be defined for object type ${objectType}, but class ${mismatched.map((c) => `${c.ID} ("${c.Name}", object type ${c.ObjectType})`).join(", ")} belongs to a different object type.`,
        "Use all_object_types=true, or only add it to classes of that object type.",
      );
    }
  }

  const request = {
    name,
    data_type: dataType,
    ...(args.valueListId !== undefined ? { value_list: args.valueListId } : {}),
    ...(allObjectTypes ? { all_object_types: true } : { object_type: objectType }),
    aliases: args.aliases,
  };
  const plan = {
    property: {
      name,
      data_type: dataType,
      data_type_name: resolveDataTypeName(dataType),
      ...(valueList ? { value_list: { id: valueList.ID, name: valueList.Name } } : {}),
      ...(allObjectTypes
        ? { all_object_types: true }
        : { defined_for_object_type: objectType }),
      ...(args.aliases.length ? { aliases: args.aliases } : {}),
    },
    add_to_classes: classes.map((c, i) => ({
      class_id: c.ID,
      name: c.Name,
      required: args.addToClasses[i].required,
    })),
  };
  if (args.dryRun) {
    return {
      dry_run: true,
      ...plan,
      _hint:
        "Nothing was written. Call again with dry_run=false to create the property definition.",
    };
  }

  await requireCompatibleApp(client);
  let created: CreatedPropertyDef;
  let diagnostics: AppDiagnostics | undefined;
  try {
    ({ result: created, diagnostics } = await runStructureJob<CreatedPropertyDef>(
      client,
      STRUCTURE_APP_METHODS.createPropertyDef,
      request,
    ));
  } catch (err) {
    if (err instanceof StructureJobPendingError && classes.length) {
      throw new StructureJobPendingError(
        err.job,
        "It hasn't been added to any class yet: once it exists, add it with mfiles_update_class.",
      );
    }
    throw err;
  }
  const classResults = [];
  const damaged = [];
  for (const [i, cls] of classes.entries()) {
    const add = [{ propertyId: created.id, required: args.addToClasses[i].required }];
    try {
      let classDiagnostics: AppDiagnostics | undefined;
      let pendingJob: string | undefined;
      try {
        ({ diagnostics: classDiagnostics } = await submitClassUpdate(
          client,
          cls,
          { add, remove: [] },
          await expectedClassState(client, cls),
        ));
      } catch (err) {
        if (!(err instanceof StructureJobPendingError)) throw err;
        pendingJob = err.job.job_id;
      }
      const check = await verifyClassAssociations(client, cls, add, []);
      if (pendingJob && (check.lost.length || check.wrongRequired.length)) {
        throw new StructureJobPendingError({ job_id: pendingJob, kind: "update_class", status: "running" });
      }
      if (check.lost.length) damaged.push({ cls, lost: check.lost });
      classResults.push({
        class_id: cls.ID,
        name: cls.Name,
        required: args.addToClasses[i].required,
        added: true,
        ...(pendingJob
          ? { note: `REST shows it; M-Files is still finishing the save (job ${pendingJob}).` }
          : {}),
        ...(check.lost.length ? { lost_properties: check.lost } : {}),
        ...(classDiagnostics ? { vault_app: classDiagnostics } : {}),
      });
    } catch (err) {
      classResults.push({
        class_id: cls.ID,
        name: cls.Name,
        added: false,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof MFilesToolError ? { hint: err.hint } : {}),
      });
    }
  }
  const failed = classResults.filter((c) => !c.added);
  return {
    created: true,
    property: {
      id: created.id,
      ...plan.property,
    },
    ...(classResults.length ? { classes: classResults } : {}),
    ...(diagnostics ? { vault_app: diagnostics } : {}),
    ...(damaged.length
      ? { _hint: damaged.map((d) => restoreHint(d.cls, d.lost)).join(" ") }
      : failed.length
        ? {
            _hint: `The property was created (id ${created.id}) but adding it to ${failed.length} class(es) failed. Retry those with mfiles_update_class.`,
          }
        : {}),
  };
}

export interface UpdateClassArgs {
  classId: number;
  add: Array<{ propertyId: number; required: boolean }>;
  remove: number[];
  rename?: string;
  /** null removes the class's workflow. */
  workflowId?: number | null;
  forceWorkflow?: boolean;
  namePropertyId?: number;
  dryRun: boolean;
}

/**
 * Change a class: add or remove properties, flip required flags, rename it,
 * set or clear its workflow, change its name property.
 */
export async function updateClass(client: MFilesClient, args: UpdateClassArgs) {
  const settingsGiven =
    args.rename !== undefined ||
    args.workflowId !== undefined ||
    args.forceWorkflow !== undefined ||
    args.namePropertyId !== undefined;
  if (args.add.length === 0 && args.remove.length === 0 && !settingsGiven) {
    throw new MFilesToolError(
      "Nothing to change.",
      "Pass properties in add or remove, or a setting: rename, workflow, force_workflow, name_property.",
    );
  }
  const addIds = args.add.map((a) => a.propertyId);
  const allIds = [...addIds, ...args.remove];
  if (new Set(allIds).size !== allIds.length) {
    throw new MFilesToolError(
      "A property appears more than once across add and remove.",
      "List each property once. To change only the required flag, put it in add with the new required value.",
    );
  }
  if (args.rename !== undefined && !args.rename.trim()) {
    throw new MFilesToolError("rename is empty.", "Pass the class's new name, or leave rename out.");
  }

  const [cls, defs, workflow, nameDef] = await Promise.all([
    client.getClass(args.classId),
    Promise.all(allIds.map((id) => client.getProperty(id))),
    typeof args.workflowId === "number" ? client.getWorkflow(args.workflowId) : undefined,
    args.namePropertyId !== undefined ? client.getProperty(args.namePropertyId) : undefined,
  ]);
  const defById = new Map<number, MFilesPropertyDef>(defs.map((d) => [d.ID, d]));
  if (nameDef) defById.set(nameDef.ID, nameDef);

  const namePropertyAfter = args.namePropertyId ?? cls.NamePropertyDef;
  if (typeof namePropertyAfter === "number" && args.remove.includes(namePropertyAfter)) {
    throw new MFilesToolError(
      `Property ${namePropertyAfter} is the name property of class ${cls.ID} ("${cls.Name}") and can't be removed from it.`,
      "Remove it from the remove list, or make another property the name property first.",
    );
  }
  if (nameDef && nameDef.DataType !== MFDataType.Text) {
    throw new MFilesToolError(
      `Property ${nameDef.ID} ("${nameDef.Name}") is ${resolveDataTypeName(nameDef.DataType)}, but a class's name property must be Text.`,
      "Pick a Text property as name_property.",
    );
  }
  const workflowAfter = args.workflowId === undefined ? cls.Workflow ?? 0 : args.workflowId ?? 0;
  if (args.forceWorkflow === true && !workflowAfter) {
    throw new MFilesToolError(
      "force_workflow needs the class to have a workflow.",
      "Pass workflow too, or leave force_workflow out.",
    );
  }
  const serverMaintained = args.add.filter(
    (a) => (defById.get(a.propertyId)?.UpdateType ?? MFUpdateType.Normal) !== MFUpdateType.Normal,
  );
  if (serverMaintained.length) {
    throw new MFilesToolError(
      `M-Files maintains ${serverMaintained.map((a) => `${a.propertyId} ("${defById.get(a.propertyId)?.Name}")`).join(", ")} itself; they're on every class already.`,
      "Leave them out of add.",
    );
  }

  const current = new Map(
    (cls.AssociatedPropertyDefs ?? []).map((a) => [a.PropertyDef, a.Required]),
  );
  const describe = (id: number) => ({ property_id: id, name: defById.get(id)?.Name });
  const toAdd = args.add.filter((a) => !current.has(a.propertyId));
  const toUpdate = args.add.filter(
    (a) => current.has(a.propertyId) && current.get(a.propertyId) !== a.required,
  );
  const unchanged = args.add.filter((a) => current.get(a.propertyId) === a.required);
  const toRemove = args.remove.filter((id) => current.has(id));
  const notAssociated = args.remove.filter((id) => !current.has(id));

  const settings: Record<string, unknown> = {};
  const change: ClassChange = { add: [...toAdd, ...toUpdate], remove: toRemove };
  if (args.rename !== undefined && args.rename.trim() !== cls.Name) {
    settings.name = { from: cls.Name, to: args.rename.trim() };
    change.rename = args.rename.trim();
  }
  if (args.workflowId !== undefined && (args.workflowId ?? 0) !== (cls.Workflow ?? 0)) {
    settings.workflow = {
      from: cls.Workflow || null,
      to: workflow ? { id: workflow.ID, name: workflow.Name } : null,
    };
    change.workflowId = args.workflowId ?? 0;
  }
  if (args.forceWorkflow !== undefined && args.forceWorkflow !== (forcedWorkflow(cls) ?? false)) {
    settings.force_workflow = { from: forcedWorkflow(cls) ?? false, to: args.forceWorkflow };
    change.forceWorkflow = args.forceWorkflow;
  }
  if (args.namePropertyId !== undefined && args.namePropertyId !== cls.NamePropertyDef) {
    settings.name_property = {
      from: cls.NamePropertyDef ?? null,
      to: { id: args.namePropertyId, name: nameDef?.Name },
      ...(!current.has(args.namePropertyId) && !addIds.includes(args.namePropertyId)
        ? { note: "It isn't on the class yet, so it's added as required." }
        : {}),
    };
    change.namePropertyId = args.namePropertyId;
  }

  const plan = {
    class: summarizeClassBrief(cls),
    add: toAdd.map((a) => ({ ...describe(a.propertyId), required: a.required })),
    change_required: toUpdate.map((a) => ({
      ...describe(a.propertyId),
      required: a.required,
    })),
    remove: toRemove.map(describe),
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(unchanged.length || notAssociated.length
      ? {
          no_op: [
            ...unchanged.map((a) => ({
              ...describe(a.propertyId),
              reason: "already associated with this required flag",
            })),
            ...notAssociated.map((id) => ({
              ...describe(id),
              reason: "not associated with the class",
            })),
          ],
        }
      : {}),
  };

  const hasChanges =
    change.add.length > 0 || change.remove.length > 0 || Object.keys(settings).length > 0;
  if (!hasChanges) {
    return { updated: false, ...plan, _hint: "The class already matches; nothing to do." };
  }
  if (args.dryRun) {
    return {
      dry_run: true,
      ...plan,
      _hint: "Nothing was written. Call again with dry_run=false to apply.",
    };
  }

  await requireCompatibleApp(client);
  let outcome: AppResult<ClassUpdateResult> | undefined;
  let pending: StructureJobPendingError | undefined;
  try {
    outcome = await submitClassUpdate(client, cls, change, await expectedClassState(client, cls));
  } catch (err) {
    if (!(err instanceof StructureJobPendingError)) throw err;
    pending = err;
  }
  const check = await verifyClassAssociations(client, cls, change.add, change.remove, change);
  const settingProblems = check.settingProblems;
  const verificationFailed =
    check.lost.length || check.notRemoved.length || check.wrongRequired.length || settingProblems.length;
  if (pending) {
    // M-Files can keep a class save open long after applying it. If REST
    // already shows the change, say so instead of "still working".
    if (verificationFailed) throw pending;
    return {
      updated: true,
      ...plan,
      _hint: `REST shows the change, but M-Files is still finishing the save (job ${pending.job.job_id}); other structure changes wait until it's done.`,
    };
  }
  const { result, diagnostics } = outcome!;
  return {
    updated: true,
    ...plan,
    class_after: result.class,
    before: result.before,
    ...(result.warning && verificationFailed ? { vault_app_warning: result.warning } : {}),
    ...(diagnostics ? { vault_app: diagnostics } : {}),
    ...(verificationFailed
      ? {
          verification: {
            ok: false,
            lost_properties: check.lost,
            still_associated: check.notRemoved,
            wrong_required_flag: check.wrongRequired,
            settings: settingProblems,
          },
          _hint: [
            check.lost.length ? restoreHint(cls, check.lost) : "",
            check.notRemoved.length
              ? `Properties ${check.notRemoved.join(", ")} are still on the class.`
              : "",
            check.wrongRequired.length
              ? `REST shows the wrong required flag on ${check.wrongRequired.map((w) => w.property_id).join(", ")}.`
              : "",
            settingProblems.length ? `REST shows: ${settingProblems.join(", ")}.` : "",
          ].join(" ").trim(),
        }
      : {}),
  };
}

/**
 * Re-read a class over REST after the vault app changed it and list every
 * property that should be associated but isn't. App versions up to 1.0.3
 * silently dropped a class's existing properties, so this doesn't take the
 * app's word for it.
 */
async function verifyClassAssociations(
  client: MFilesClient,
  before: MFilesClass,
  add: Array<{ propertyId: number; required: boolean }>,
  remove: number[],
  settings: Pick<ClassChange, "rename" | "workflowId" | "namePropertyId"> = {},
) {
  const expected = new Map(
    (before.AssociatedPropertyDefs ?? []).map((a) => [a.PropertyDef, a.Required]),
  );
  for (const id of remove) expected.delete(id);
  for (const a of add) expected.set(a.propertyId, a.required);
  const compare = (after: MFilesClass) => {
    const now = new Set((after.AssociatedPropertyDefs ?? []).map((a) => a.PropertyDef));
    const flags = new Map((after.AssociatedPropertyDefs ?? []).map((a) => [a.PropertyDef, a.Required]));
    const settingProblems: string[] = [];
    if (settings.rename !== undefined && after.Name !== settings.rename) settingProblems.push(`name is "${after.Name}"`);
    if (settings.workflowId !== undefined && (after.Workflow ?? 0) !== settings.workflowId) settingProblems.push(`workflow is ${after.Workflow || "none"}`);
    if (settings.namePropertyId !== undefined && after.NamePropertyDef !== settings.namePropertyId) settingProblems.push(`name property is ${after.NamePropertyDef}`);
    return {
      lost: [...expected]
        .filter(([id]) => !now.has(id))
        .map(([property_id, required]) => ({ property_id, required })),
      notRemoved: remove.filter((id) => now.has(id)),
      wrongRequired: add
        .filter((a) => now.has(a.propertyId) && flags.get(a.propertyId) !== a.required)
        .map((a) => ({ property_id: a.propertyId, required: flags.get(a.propertyId) })),
      settingProblems,
    };
  };
  const ok = (c: ReturnType<typeof compare>) =>
    !c.lost.length && !c.notRemoved.length && !c.wrongRequired.length && !c.settingProblems.length;
  const first = compare(await client.getClass(before.ID));
  if (ok(first)) return first;
  // REST can lag a moment behind a structure change; look again before
  // calling it a problem.
  await sleep(verifyRetryMs);
  return compare(await client.getClass(before.ID));
}

function restoreHint(
  cls: MFilesClass,
  lost: Array<{ property_id: number; required: boolean }>,
): string {
  return `Class ${cls.ID} ("${cls.Name}") lost properties during the update: ${lost.map((l) => l.property_id).join(", ")}. Restore them now with mfiles_update_class class_id=${cls.ID} add=${JSON.stringify(lost)}, then tell the user.`;
}

function summarizeClassBrief(cls: MFilesClass) {
  return { id: cls.ID, name: cls.Name, object_type: cls.ObjectType };
}

export interface CreateClassArgs {
  objectTypeId: number;
  name: string;
  namePropertyId?: number;
  properties: Array<{ propertyId: number; required: boolean }>;
  workflowId?: number;
  forceWorkflow: boolean;
  aliases: string[];
  allowDuplicateName: boolean;
  dryRun: boolean;
}

export async function createClass(client: MFilesClient, args: CreateClassArgs) {
  const name = args.name.trim();
  if (!name) throw new MFilesToolError("The class name is empty.", "Pass a non-blank name.");
  if (args.forceWorkflow && args.workflowId === undefined) {
    throw new MFilesToolError("force_workflow needs a workflow.", "Pass workflow too, or leave force_workflow out.");
  }
  const ids = args.properties.map((p) => p.propertyId);
  if (new Set(ids).size !== ids.length) {
    throw new MFilesToolError("A property appears more than once in properties.", "List each property once.");
  }

  const [objectType, classes, defs, workflow, nameDef] = await Promise.all([
    client.getObjectType(args.objectTypeId),
    client.listClasses(args.objectTypeId),
    Promise.all(ids.map((id) => client.getProperty(id))),
    args.workflowId !== undefined ? client.getWorkflow(args.workflowId) : undefined,
    client.getProperty(args.namePropertyId ?? 0),
  ]);
  if (objectType.RealObjectType === false) {
    throw new MFilesToolError(
      `${args.objectTypeId} ("${objectType.Name}") is a value list, not an object type; only object types have classes.`,
      "Pick an object type from mfiles_list_object_types.",
    );
  }
  const duplicates = classes.filter((c) => sameName(c.Name, name));
  if (duplicates.length && !args.allowDuplicateName) {
    throw new MFilesToolError(
      `Object type ${objectType.ID} already has a class named "${name}": ${duplicates.map((c) => c.ID).join(", ")}.`,
      "Change that class with mfiles_update_class, pick another name, or pass allow_duplicate_name=true.",
    );
  }
  if (nameDef.DataType !== MFDataType.Text) {
    throw new MFilesToolError(
      `Property ${nameDef.ID} ("${nameDef.Name}") is ${resolveDataTypeName(nameDef.DataType)}, but a class's name property must be Text.`,
      "Pick a Text property as name_property, or leave it out to use Name or title.",
    );
  }
  const serverMaintained = defs.filter((d) => (d.UpdateType ?? MFUpdateType.Normal) !== MFUpdateType.Normal);
  if (serverMaintained.length) {
    throw new MFilesToolError(
      `M-Files maintains ${serverMaintained.map((d) => `${d.ID} ("${d.Name}")`).join(", ")} itself; they're on every class already.`,
      "Leave them out of properties.",
    );
  }

  const plan = {
    class: {
      name,
      object_type: { id: objectType.ID, name: objectType.Name },
      name_property: { id: nameDef.ID, name: nameDef.Name },
      ...(workflow ? { workflow: { id: workflow.ID, name: workflow.Name }, force_workflow: args.forceWorkflow } : {}),
      ...(args.aliases.length ? { aliases: args.aliases } : {}),
    },
    properties: args.properties.map((p, i) => ({ property_id: p.propertyId, name: defs[i].Name, required: p.required })),
  };
  if (args.dryRun) {
    return { dry_run: true, ...plan, _hint: "Nothing was written. Call again with dry_run=false to create the class." };
  }

  await requireCompatibleApp(client);
  const { result, diagnostics } = await runStructureJob<{ class: AdminClass; warning?: string | null }>(
    client,
    STRUCTURE_APP_METHODS.createClass,
    {
      object_type: args.objectTypeId,
      name,
      name_property_def: nameDef.ID,
      properties: args.properties.map((p) => ({ property_id: p.propertyId, required: p.required })),
      ...(args.workflowId !== undefined ? { workflow: args.workflowId, force_workflow: args.forceWorkflow } : {}),
      aliases: args.aliases,
    },
  );
  const created = result.class;
  const rest = await client.getClass(created.id).catch(() => undefined);
  const onClass = new Set((rest?.AssociatedPropertyDefs ?? []).map((a) => a.PropertyDef));
  const missing = rest ? args.properties.filter((p) => !onClass.has(p.propertyId)).map((p) => p.propertyId) : [];
  return {
    created: true,
    class: created,
    ...(diagnostics ? { vault_app: diagnostics } : {}),
    ...(!rest
      ? {
          _hint: `The class was created (id ${created.id}) but REST can't see it yet; check its permissions with the user.`,
        }
      : missing.length
        ? {
            _hint: `The class was created (id ${created.id}) but REST doesn't show properties ${missing.join(", ")} on it. Add them with mfiles_update_class class_id=${created.id}.`,
          }
        : {}),
  };
}

// ---------------------------------------------------------------------------
// Value lists

interface CreatedValueList {
  id: number;
  name_singular: string;
  name_plural: string;
  items: Array<{ id: number; name: string }>;
  failed_items: Array<{ name: string; error: string }>;
}

export interface CreateValueListArgs {
  nameSingular: string;
  namePlural?: string;
  aliases: string[];
  items: string[];
  allowDuplicateName: boolean;
  dryRun: boolean;
}

export async function createValueList(
  client: MFilesClient,
  args: CreateValueListArgs,
) {
  const nameSingular = args.nameSingular.trim();
  const namePlural = args.namePlural?.trim() || nameSingular;
  if (!nameSingular) {
    throw new MFilesToolError("The value list name is empty.", "Pass a non-blank name_singular.");
  }
  const items: string[] = [];
  for (const raw of args.items) {
    const item = raw.trim();
    if (item && !items.some((i) => sameName(i, item))) items.push(item);
  }

  const existing = await client.listValueLists();
  const duplicates = existing.filter((vl) => sameName(vl.Name, nameSingular));
  if (duplicates.length > 0 && !args.allowDuplicateName) {
    throw new MFilesToolError(
      `A value list named "${nameSingular}" already exists: ${duplicates.map((v) => v.ID).join(", ")}.`,
      "Reuse it (mfiles_create_value_list_item adds items), pick another name, or pass allow_duplicate_name=true.",
    );
  }

  const plan = {
    value_list: {
      name_singular: nameSingular,
      name_plural: namePlural,
      ...(args.aliases.length ? { aliases: args.aliases } : {}),
    },
    items,
  };
  if (args.dryRun) {
    return {
      dry_run: true,
      ...plan,
      _hint: "Nothing was written. Call again with dry_run=false to create the value list.",
    };
  }

  await requireCompatibleApp(client);
  const { result: created, diagnostics } = await runStructureJob<CreatedValueList>(
    client,
    STRUCTURE_APP_METHODS.createValueList,
    {
      name_singular: nameSingular,
      name_plural: namePlural,
      aliases: args.aliases,
      items,
    },
  );
  const failed = created.failed_items ?? [];
  return {
    created: true,
    value_list: {
      id: created.id,
      name_singular: created.name_singular,
      name_plural: created.name_plural,
    },
    items: created.items,
    ...(failed.length ? { failed_items: failed } : {}),
    ...(diagnostics ? { vault_app: diagnostics } : {}),
    _hint: failed.length
      ? `The value list exists (id ${created.id}) but ${failed.length} item(s) failed; retry them with mfiles_create_value_list_item.`
      : `Use value_list_id=${created.id} with mfiles_create_property_def (data_type SingleSelectLookup or MultiSelectLookup) to make a property that draws from it.`,
  };
}

// ---------------------------------------------------------------------------
// Object types

interface CreatedObjectType {
  id: number;
  name_singular: string;
  name_plural: string;
  can_have_files: boolean;
  allow_adding: boolean;
  owner_object_type?: number | null;
  owner_property_def?: number | null;
  default_property_def: number;
  classes: Array<{ id: number; name: string }>;
}

export interface CreateObjectTypeArgs {
  nameSingular: string;
  namePlural?: string;
  canHaveFiles: boolean;
  allowAdding: boolean;
  ownerObjectTypeId?: number;
  aliases: string[];
  allowDuplicateName: boolean;
  dryRun: boolean;
}

/**
 * Create an object type (objects with metadata cards, unlike a value list).
 * M-Files adds a property definition that refers to the new type, and
 * usually a class of the same name.
 */
export async function createObjectType(client: MFilesClient, args: CreateObjectTypeArgs) {
  const nameSingular = args.nameSingular.trim();
  const namePlural = args.namePlural?.trim() || nameSingular;
  if (!nameSingular) {
    throw new MFilesToolError("The object type name is empty.", "Pass a non-blank name_singular.");
  }

  const [types, lists, owner] = await Promise.all([
    client.listObjectTypes(),
    client.listValueLists(),
    args.ownerObjectTypeId !== undefined ? client.getObjectType(args.ownerObjectTypeId) : undefined,
  ]);
  const seen = new Set<number>();
  const all = [...types, ...lists].filter((t) => !seen.has(t.ID) && seen.add(t.ID));
  const duplicates = all.filter(
    (t) => sameName(t.Name, nameSingular) || (typeof t.NamePlural === "string" && sameName(t.NamePlural, namePlural)),
  );
  if (duplicates.length && !args.allowDuplicateName) {
    throw new MFilesToolError(
      `An object type or value list is already called "${nameSingular}" or "${namePlural}": ${duplicates.map((t) => `${t.ID} ("${t.Name}")`).join(", ")}.`,
      "Use it (mfiles_create_class adds classes to an object type), pick another name, or pass allow_duplicate_name=true.",
    );
  }

  const plan = {
    object_type: {
      name_singular: nameSingular,
      name_plural: namePlural,
      can_have_files: args.canHaveFiles,
      allow_adding: args.allowAdding,
      ...(owner ? { owner: { id: owner.ID, name: owner.Name } } : {}),
      ...(args.aliases.length ? { aliases: args.aliases } : {}),
    },
  };
  if (args.dryRun) {
    return {
      dry_run: true,
      ...plan,
      _hint: "Nothing was written. Call again with dry_run=false to create it. M-Files also adds a property definition that refers to the new type, and usually a class of the same name.",
    };
  }

  await requireAppMethod(client, STRUCTURE_APP_METHODS.createObjectType, "1.0.11");
  let created: CreatedObjectType;
  let diagnostics: AppDiagnostics | undefined;
  try {
    ({ result: created, diagnostics } = await runStructureJob<CreatedObjectType>(
      client,
      STRUCTURE_APP_METHODS.createObjectType,
      {
        name_singular: nameSingular,
        name_plural: namePlural,
        can_have_files: args.canHaveFiles,
        allow_adding: args.allowAdding,
        ...(args.ownerObjectTypeId !== undefined ? { owner_object_type: args.ownerObjectTypeId } : {}),
        aliases: args.aliases,
      },
    ));
  } catch (err) {
    if (!(err instanceof StructureJobPendingError)) throw err;
    // M-Files can keep a structure save open long after applying it.
    const fresh = (await client.listObjectTypes()).find(
      (t) => sameName(t.Name, nameSingular) && !types.some((old) => old.ID === t.ID),
    );
    if (!fresh) throw err;
    return {
      created: true,
      object_type: { id: fresh.ID, name_singular: fresh.Name, name_plural: fresh.NamePlural },
      _hint: `REST shows the new object type, but M-Files is still finishing the save (job ${err.job.job_id}). Add classes with mfiles_create_class object_type_id=${fresh.ID}.`,
    };
  }
  const classes = created.classes ?? [];
  return {
    created: true,
    object_type: created,
    ...(diagnostics ? { vault_app: diagnostics } : {}),
    _hint: `M-Files added property definition ${created.default_property_def} (it refers to the new type)${classes.length ? ` and class ${classes.map((c) => `${c.id} "${c.name}"`).join(", ")}` : ""}. Add properties with mfiles_update_class, or more classes with mfiles_create_class object_type_id=${created.id}.`,
  };
}
