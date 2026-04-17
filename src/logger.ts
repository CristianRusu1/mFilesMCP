const enabled = (process.env.DEBUG ?? "").split(",").some(
  (tag) => tag === "*" || tag === "mfiles:*" || tag.startsWith("mfiles"),
);

export function debug(...args: unknown[]): void {
  if (!enabled) return;
  const parts = args.map((a) =>
    typeof a === "string" ? a : JSON.stringify(a),
  );
  process.stderr.write(`[mfiles] ${parts.join(" ")}\n`);
}

export function logError(err: unknown): void {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[mfiles:error] ${msg}\n`);
}
