import { spawn } from "node:child_process";
import { config as loadEnv } from "dotenv";

loadEnv();

const child = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, DEBUG: "mfiles:*" },
});

type JsonMessage = Record<string, unknown>;

function send(msg: JsonMessage) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

let nextId = 1;
const pending = new Map<number, (r: JsonMessage) => void>();

child.stdout.setEncoding("utf8");
let buf = "";
child.stdout.on("data", (chunk: string) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const obj = JSON.parse(line) as JsonMessage;
    const id = obj.id as number | undefined;
    if (id !== undefined && pending.has(id)) {
      pending.get(id)!(obj);
      pending.delete(id);
    }
  }
});

function call(method: string, params: unknown): Promise<JsonMessage> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function notify(method: string, params: unknown) {
  send({ jsonrpc: "2.0", method, params });
}

async function main() {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "flow-test", version: "1.0" },
  });
  notify("notifications/initialized", {});

  console.error("\n--- authenticate_from_env ---");
  const auth = await call("tools/call", {
    name: "mfiles_authenticate_from_env",
    arguments: {},
  });
  console.error(JSON.stringify(auth, null, 2));

  const vaultGuid = process.env.MFILES_VAULT_GUID!;

  console.error("\n--- find_by_name patient ---");
  const find = await call("tools/call", {
    name: "mfiles_find_by_name",
    arguments: { vault_guid: vaultGuid, name: "patient" },
  });
  console.error(JSON.stringify(find, null, 2));

  console.error("\n--- describe_class (first real class) ---");
  const classes = await call("tools/call", {
    name: "mfiles_list_classes",
    arguments: { vault_guid: vaultGuid },
  });
  const parsed = JSON.parse(
    (classes.result as any).content[0].text as string,
  );
  const firstRealClass = parsed.classes.find((c: any) => c.id > 0);
  console.error(`selected class id=${firstRealClass.id} name=${firstRealClass.name}`);
  const desc = await call("tools/call", {
    name: "mfiles_describe_class",
    arguments: {
      vault_guid: vaultGuid,
      class_id: firstRealClass.id,
      include_value_list_items: false,
    },
  });
  console.error(JSON.stringify(desc, null, 2));

  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED", err);
  child.kill();
  process.exit(1);
});
