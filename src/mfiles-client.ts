import {
  MFilesAuthError,
  MFilesAuthResponse,
  MFilesClass,
  MFilesObjectType,
  MFilesPropertyDef,
  MFilesRequestError,
  MFilesValueList,
  MFilesValueListItem,
  MFilesValueListItemsResponse,
} from "./types.js";
import { debug } from "./logger.js";

const DEFAULT_TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;

export interface AuthenticatedSession {
  token: string;
  expiresAt: Date;
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

  private async request<T>(path: string): Promise<T> {
    if (!this.token) {
      throw new MFilesAuthError(
        "No session token — authenticate first.",
      );
    }
    const url = `${this.baseUrl}${path}`;
    debug("GET", url);
    const res = await fetch(url, {
      headers: {
        "X-Authentication": this.token,
        Accept: "application/json",
      },
    });
    if (res.status === 401) {
      this.clearToken();
      throw new MFilesAuthError(
        "Session token rejected (401). Re-authenticate.",
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MFilesRequestError(
        `M-Files REST ${res.status} ${res.statusText} at ${path}: ${body.slice(0, 300)}`,
        res.status,
        body,
      );
    }
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
}
