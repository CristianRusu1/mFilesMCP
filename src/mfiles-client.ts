import {
  MFCheckOutStatus,
  MFilesAuthError,
  MFilesAuthResponse,
  MFilesClass,
  MFilesExtendedObjectVersion,
  MFilesObjectCreationInfo,
  MFilesObjectType,
  MFilesObjectVersion,
  MFilesPropertyDef,
  MFilesPropertyValue,
  MFilesRequestError,
  MFilesValueList,
  MFilesValueListItem,
  MFilesValueListItemsResponse,
  MFilesWorkflow,
  MFilesWorkflowState,
} from "./types.js";
import { debug } from "./logger.js";

const DEFAULT_TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;

export interface AuthenticatedSession {
  token: string;
  expiresAt: Date;
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface RequestOptions {
  method?: HttpMethod;
  /** Serialized as application/json. */
  json?: unknown;
  /** Sent verbatim as text/plain (vault extension method input). */
  text?: string;
}

/**
 * MFWS error bodies are JSON with a top-level Message (and an Exception
 * object). Pull out the human-readable part so the LLM sees why M-Files
 * refused, not a stack trace.
 */
export function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      Message?: unknown;
      Exception?: { Message?: unknown };
    };
    const msg = parsed?.Message ?? parsed?.Exception?.Message;
    return typeof msg === "string" && msg.trim() ? msg.trim() : undefined;
  } catch {
    return undefined;
  }
}

export class MFilesClient {
  private token: string | null = null;
  private expiresAt: Date | null = null;

  constructor(readonly baseUrl: string) {
    if (!baseUrl) throw new Error("MFilesClient requires a baseUrl");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  hasToken(): boolean {
    return !!this.token;
  }

  getSession(): AuthenticatedSession | null {
    if (!this.token || !this.expiresAt) return null;
    return { token: this.token, expiresAt: this.expiresAt };
  }

  clearToken(): void {
    this.token = null;
    this.expiresAt = null;
  }

  async authenticate(
    vaultGuid: string,
    username: string,
    password: string,
  ): Promise<AuthenticatedSession> {
    const url = `${this.baseUrl}/REST/server/authenticationtokens.aspx`;
    const normalizedGuid = vaultGuid.startsWith("{")
      ? vaultGuid
      : `{${vaultGuid.replace(/^\{|\}$/g, "")}}`;
    debug("auth POST", url, "vault=", normalizedGuid);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Username: username,
        Password: password,
        VaultGuid: normalizedGuid,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MFilesAuthError(
        `Authentication failed (${res.status} ${res.statusText}): ${body.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as MFilesAuthResponse;
    if (!json.Value) {
      throw new MFilesAuthError(
        "Authentication response missing token Value field",
      );
    }
    this.token = json.Value;
    this.expiresAt = json.Expiration
      ? new Date(json.Expiration)
      : new Date(Date.now() + DEFAULT_TOKEN_LIFETIME_MS);
    return { token: this.token, expiresAt: this.expiresAt };
  }

  private async send(
    path: string,
    { method = "GET", json, text }: RequestOptions,
  ): Promise<Response> {
    if (!this.token) {
      throw new MFilesAuthError(
        "No session token — authenticate first.",
      );
    }
    let url = `${this.baseUrl}${path}`;
    let httpMethod: string = method;
    // IIS frequently blocks PUT/DELETE; MFWS accepts them tunnelled through
    // POST with a _method query parameter.
    if (method === "PUT" || method === "DELETE") {
      url += `${url.includes("?") ? "&" : "?"}_method=${method}`;
      httpMethod = "POST";
    }
    const headers: Record<string, string> = {
      "X-Authentication": this.token,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (text !== undefined) {
      headers["Content-Type"] = "text/plain; charset=utf-8";
      body = text;
    } else if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    }
    debug(method, url);
    const res = await fetch(url, { method: httpMethod, headers, body });
    if (res.status === 401) {
      this.clearToken();
      throw new MFilesAuthError(
        "Session token rejected (401). Re-authenticate.",
      );
    }
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      const serverMessage = extractErrorMessage(errorBody);
      throw new MFilesRequestError(
        `M-Files REST ${res.status} ${res.statusText} at ${path}: ${serverMessage ?? errorBody.slice(0, 300)}`,
        res.status,
        errorBody,
        serverMessage,
      );
    }
    return res;
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const res = await this.send(path, options);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  listObjectTypes(): Promise<MFilesObjectType[]> {
    return this.request<MFilesObjectType[]>(
      `/REST/structure/objecttypes.aspx`,
    );
  }

  async listClasses(objectTypeId?: number): Promise<MFilesClass[]> {
    const all = await this.request<MFilesClass[]>(
      `/REST/structure/classes.aspx`,
    );
    if (typeof objectTypeId === "number") {
      return all.filter((c) => c.ObjectType === objectTypeId);
    }
    return all;
  }

  getClass(classId: number): Promise<MFilesClass> {
    return this.request<MFilesClass>(
      `/REST/structure/classes/${classId}.aspx`,
    );
  }

  listProperties(): Promise<MFilesPropertyDef[]> {
    return this.request<MFilesPropertyDef[]>(
      `/REST/structure/properties.aspx`,
    );
  }

  getProperty(propertyId: number): Promise<MFilesPropertyDef> {
    return this.request<MFilesPropertyDef>(
      `/REST/structure/properties/${propertyId}.aspx`,
    );
  }

  listWorkflows(): Promise<MFilesWorkflow[]> {
    return this.request<MFilesWorkflow[]>(`/REST/structure/workflows.aspx`);
  }

  getWorkflow(workflowId: number): Promise<MFilesWorkflow> {
    return this.request<MFilesWorkflow>(
      `/REST/structure/workflows/${workflowId}.aspx`,
    );
  }

  getWorkflowStates(workflowId: number): Promise<MFilesWorkflowState[]> {
    return this.request<MFilesWorkflowState[]>(
      `/REST/structure/workflows/${workflowId}/states.aspx`,
    );
  }

  async listValueLists(): Promise<MFilesValueList[]> {
    const all = await this.request<MFilesValueList[]>(`/REST/valuelists.aspx`);
    return all.filter((vl) => !vl.RealObjectType);
  }

  async getValueListItems(valueListId: number): Promise<MFilesValueListItem[]> {
    const resp = await this.request<
      MFilesValueListItemsResponse | MFilesValueListItem[]
    >(`/REST/valuelists/${valueListId}/items.aspx`);
    if (Array.isArray(resp)) return resp;
    return resp.Items ?? [];
  }

  getObjectType(objectTypeId: number): Promise<MFilesObjectType> {
    return this.request<MFilesObjectType>(
      `/REST/structure/objecttypes/${objectTypeId}.aspx`,
    );
  }

  getValueList(valueListId: number): Promise<MFilesValueList> {
    return this.request<MFilesValueList>(`/REST/valuelists/${valueListId}.aspx`);
  }

  /** Items whose name matches `filter` (MFWS-side match, wildcards allowed). */
  async findValueListItems(
    valueListId: number,
    filter: string,
  ): Promise<MFilesValueListItem[]> {
    const resp = await this.request<
      MFilesValueListItemsResponse | MFilesValueListItem[]
    >(
      `/REST/valuelists/${valueListId}/items.aspx?filter=${encodeURIComponent(filter)}`,
    );
    if (Array.isArray(resp)) return resp;
    return resp.Items ?? [];
  }

  createValueListItem(
    valueListId: number,
    item: Partial<MFilesValueListItem> & { Name: string },
  ): Promise<MFilesValueListItem> {
    return this.request<MFilesValueListItem>(
      `/REST/valuelists/${valueListId}/items.aspx`,
      { method: "POST", json: item },
    );
  }

  // Object endpoints. `version` is a version number or "latest".

  private objectPath(
    objectType: number,
    objectId: number,
    version: number | "latest",
  ): string {
    return `/REST/objects/${objectType}/${objectId}/${version}`;
  }

  getObjectVersion(
    objectType: number,
    objectId: number,
    version: number | "latest" = "latest",
  ): Promise<MFilesExtendedObjectVersion> {
    return this.request<MFilesExtendedObjectVersion>(
      `${this.objectPath(objectType, objectId, version)}.aspx?include=properties`,
    );
  }

  checkOut(
    objectType: number,
    objectId: number,
  ): Promise<MFilesObjectVersion> {
    return this.request<MFilesObjectVersion>(
      `${this.objectPath(objectType, objectId, "latest")}/checkedout.aspx`,
      { method: "PUT", json: { Value: MFCheckOutStatus.CheckedOutToMe } },
    );
  }

  checkIn(
    objectType: number,
    objectId: number,
    version: number,
  ): Promise<MFilesObjectVersion> {
    return this.request<MFilesObjectVersion>(
      `${this.objectPath(objectType, objectId, version)}/checkedout.aspx`,
      { method: "PUT", json: { Value: MFCheckOutStatus.CheckedIn } },
    );
  }

  /** DELETE on a checked-out version destroys it, i.e. undoes the checkout. */
  async undoCheckout(
    objectType: number,
    objectId: number,
    version: number,
  ): Promise<void> {
    await this.request<unknown>(
      `${this.objectPath(objectType, objectId, version)}.aspx`,
      { method: "DELETE" },
    );
  }

  /** Adds or overwrites the given properties; others are left untouched. */
  setProperties(
    objectType: number,
    objectId: number,
    version: number,
    properties: MFilesPropertyValue[],
  ): Promise<MFilesExtendedObjectVersion> {
    return this.request<MFilesExtendedObjectVersion>(
      `${this.objectPath(objectType, objectId, version)}/properties.aspx`,
      { method: "POST", json: properties },
    );
  }

  removeProperty(
    objectType: number,
    objectId: number,
    version: number,
    propertyId: number,
  ): Promise<MFilesExtendedObjectVersion> {
    return this.request<MFilesExtendedObjectVersion>(
      `${this.objectPath(objectType, objectId, version)}/properties/${propertyId}.aspx`,
      { method: "DELETE" },
    );
  }

  createObject(
    objectType: number,
    info: MFilesObjectCreationInfo,
  ): Promise<MFilesObjectVersion> {
    return this.request<MFilesObjectVersion>(
      `/REST/objects/${objectType}.aspx`,
      { method: "POST", json: info },
    );
  }

  /**
   * Runs a vault extension method (e.g. one exposed by a VAF app). Input and
   * output are opaque strings; callers decide on the encoding.
   */
  async executeExtensionMethod(name: string, input: string): Promise<string> {
    const res = await this.send(
      `/REST/vault/extensionmethod/${encodeURIComponent(name)}.aspx`,
      { method: "POST", text: input },
    );
    return res.text();
  }
}
