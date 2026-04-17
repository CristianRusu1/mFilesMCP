import { config as loadEnv } from "dotenv";
import { MFilesClient } from "../src/mfiles-client.js";

loadEnv();

async function main() {
  const { MFILES_URL, MFILES_VAULT_GUID, MFILES_USERNAME, MFILES_PASSWORD } =
    process.env;

  if (!MFILES_URL || !MFILES_VAULT_GUID || !MFILES_USERNAME || !MFILES_PASSWORD) {
    console.error(
      "Missing required env vars: MFILES_URL, MFILES_VAULT_GUID, MFILES_USERNAME, MFILES_PASSWORD",
    );
    process.exit(1);
  }

  console.error(`[smoke] base url: ${MFILES_URL}`);
  const client = new MFilesClient(MFILES_URL);

  console.error("[smoke] authenticating...");
  const session = await client.authenticate(
    MFILES_VAULT_GUID,
    MFILES_USERNAME,
    MFILES_PASSWORD,
  );
  console.error(
    `[smoke] authenticated. token expires at ${session.expiresAt.toISOString()}`,
  );

  console.error("[smoke] listing object types...");
  const objectTypes = await client.listObjectTypes();
  console.error(`[smoke] got ${objectTypes.length} object types`);
  for (const ot of objectTypes.slice(0, 5)) {
    console.error(`  - id=${ot.ID} name=${ot.Name}`);
  }

  console.error("[smoke] listing classes...");
  const classes = await client.listClasses();
  console.error(`[smoke] got ${classes.length} classes`);
  for (const c of classes.slice(0, 5)) {
    console.error(
      `  - id=${c.ID} name=${c.Name} object_type=${c.ObjectType}`,
    );
  }

  if (classes[0]) {
    const first = classes[0];
    console.error(`[smoke] fetching class detail for id=${first.ID}...`);
    const detail = await client.getClass(first.ID);
    console.error(
      `  class: ${detail.Name} assoc_props=${(detail.AssociatedPropertyDefs ?? []).length}`,
    );

    const propIds = (detail.AssociatedPropertyDefs ?? [])
      .slice(0, 3)
      .map((a) => a.PropertyDef);
    for (const pid of propIds) {
      const p = await client.getProperty(pid);
      console.error(
        `  prop id=${p.ID} name=${p.Name} data_type=${p.DataType} value_list=${p.ValueList ?? "-"}`,
      );
    }
  }

  console.error("[smoke] listing value lists...");
  const valueLists = await client.listValueLists();
  console.error(`[smoke] got ${valueLists.length} value lists`);

  console.error("[smoke] OK");
}

main().catch((err) => {
  console.error("[smoke] FAILED", err);
  process.exit(1);
});
