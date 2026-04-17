import { MFilesAuthError, MFilesRequestError } from "../types.js";
import { logError } from "../logger.js";

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export const MAX_LIST_ITEMS = 200;

export function ok(payload: unknown): ToolTextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function fail(error: string, hint: string): ToolTextResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error, hint }, null, 2),
      },
    ],
    isError: true,
  };
}

export function truncateList<T>(
  items: T[],
  hint: string,
): { items: T[]; _hint?: string; _truncated?: boolean; _total?: number } {
  if (items.length <= MAX_LIST_ITEMS) return { items };
  return {
    items: items.slice(0, MAX_LIST_ITEMS),
    _truncated: true,
    _total: items.length,
    _hint: `Response truncated at ${MAX_LIST_ITEMS} of ${items.length} items. ${hint}`,
  };
}

/**
 * Run a tool body and translate any thrown error into a structured {error,hint}
 * so the LLM can recover.
 */
export async function runTool(
  fn: () => Promise<ToolTextResult>,
): Promise<ToolTextResult> {
  try {
    return await fn();
  } catch (err) {
    logError(err);
    if (err instanceof MFilesAuthError) {
      return fail(
        err.message,
        "Token missing or expired. Call mfiles_authenticate_from_env (or mfiles_authenticate) and retry.",
      );
    }
    if (err instanceof MFilesRequestError) {
      return fail(
        err.message,
        err.status === 404
          ? "Resource not found. Verify the ID by listing structure items first."
          : "REST call failed. Check the vault URL, network, and that the vault is online.",
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return fail(msg, "Unexpected error. Check DEBUG=mfiles:* logs on stderr.");
  }
}
