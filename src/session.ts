import { MFilesClient } from "./mfiles-client.js";
import { MFilesAuthError } from "./types.js";

export interface SessionEntry {
  client: MFilesClient;
  url: string;
  token: string;
  expiresAt: Date;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  private key(vaultGuid: string): string {
    return vaultGuid.replace(/[{}]/g, "").toUpperCase();
  }

  set(vaultGuid: string, entry: SessionEntry): void {
    this.sessions.set(this.key(vaultGuid), entry);
  }

  clear(vaultGuid: string): void {
    this.sessions.delete(this.key(vaultGuid));
  }

  /**
   * Returns the authenticated client for a vault, or throws MFilesAuthError
   * so the tool layer can convert it into a re-auth hint.
   */
  require(vaultGuid: string): MFilesClient {
    const entry = this.sessions.get(this.key(vaultGuid));
    if (!entry) {
      throw new MFilesAuthError(
        `Vault ${vaultGuid} is not authenticated. Call mfiles_authenticate_from_env or mfiles_authenticate first.`,
      );
    }
    if (entry.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(this.key(vaultGuid));
      entry.client.clearToken();
      throw new MFilesAuthError(
        `Session for vault ${vaultGuid} has expired. Re-authenticate via mfiles_authenticate_from_env.`,
      );
    }
    return entry.client;
  }

  list(): Array<{ vaultGuid: string; url: string; expiresAt: string }> {
    return [...this.sessions.entries()].map(([vaultGuid, entry]) => ({
      vaultGuid,
      url: entry.url,
      expiresAt: entry.expiresAt.toISOString(),
    }));
  }

  get(vaultGuid: string): SessionEntry | undefined {
    return this.sessions.get(this.key(vaultGuid));
  }
}

export const sessions = new SessionStore();
