import { afterEach, beforeEach } from "node:test";
import { STRUCTURE_APP_PROTOCOL, STRUCTURE_APP_METHODS } from "../src/structure-app.js";
import type { Route } from "./helpers.js";

export function ext(method: string): string {
  return `/REST/vault/extensionmethod/${method}.aspx`;
}

export function appOk(result: unknown): string {
  return JSON.stringify({ ok: true, result });
}

let jobCounter = 0;

/** A job the app finished before answering. */
export function jobDone(result: unknown, diagnostics: Record<string, unknown> | null = null): string {
  return appOk({ job_id: `job${++jobCounter}`, kind: "test", status: "succeeded", result, diagnostics });
}

export function jobFailed(error: string, errorCode: string | null = null, diagnostics: Record<string, unknown> | null = null): string {
  return appOk({ job_id: `job${++jobCounter}`, kind: "test", status: "failed", error, error_code: errorCode, diagnostics });
}

export function jobRunning(jobId: string, step = "saving"): string {
  return appOk({ job_id: jobId, kind: "test", status: "running", step });
}

export const PING_OK: Route = {
  method: "POST",
  path: ext(STRUCTURE_APP_METHODS.ping),
  text: appOk({ app: "MFilesMCP", version: "1.0.7.0", protocol: STRUCTURE_APP_PROTOCOL, vault_ready: true }),
};

const STRUCTURE_ENV = [
  "MFILES_USERNAME",
  "MFILES_PASSWORD",
  "MFILES_DOMAIN",
  "MFILES_STRUCTURE_LOGIN",
  "MFILES_STRUCTURE_WAIT_SECONDS",
  "MFILES_STRUCTURE_SERVER_ENDPOINT",
];

/**
 * Clears the env vars the structure bridge reads before each test and puts
 * them back afterwards; tests set what they need.
 */
export function useStructureEnv(): void {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(STRUCTURE_ENV.map((k) => [k, process.env[k]]));
    for (const k of STRUCTURE_ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const k of STRUCTURE_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}
