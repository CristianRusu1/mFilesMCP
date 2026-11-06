import type { MFilesClient } from "./mfiles-client.js";
import { logError } from "./logger.js";
import {
  BuiltInPropertyDef,
  MFDataType,
  MFUpdateType,
  MFilesToolError,
  resolveDataTypeName,
} from "./types.js";
import type {
  MFilesClass,
  MFilesExtendedObjectVersion,
  MFilesObjectVersion,
  MFilesPropertyDef,
  MFilesPropertyValue,
  MFilesTypedValue,
  MFilesValueListItem,
} from "./types.js";
import {
  summarizePropertyValue,
  summarizeTypedValue,
  toTypedValue,
} from "./typed-values.js";
import type { FriendlyValue, LookupResolver } from "./typed-values.js";

/** A property given either by ID (number) or by exact name (string). */
export type PropertyRef = number | string;

export interface PropertyAssignment {
  property: PropertyRef;
  value: FriendlyValue;
  append?: boolean;
}

export function summarizeObjectVersion(
  ov: MFilesObjectVersion,
  className?: string,
) {
  return {
    object_type: ov.ObjVer.Type,
    id: ov.ObjVer.ID,
    version: ov.ObjVer.Version,
    display_id: ov.DisplayID,
    title: ov.Title,
    class: ov.Class,
    ...(className !== undefined ? { class_name: className } : {}),
    checked_out: ov.ObjectCheckedOut ?? false,
    ...(ov.ObjectCheckedOut
      ? { checked_out_to: ov.CheckedOutToUserName ?? ov.CheckedOutTo }
      : {}),
    last_modified_utc: ov.LastModifiedUtc,
    ...(ov.Deleted ? { deleted: true } : {}),
  };
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Resolve property references to full definitions. Names are matched exactly
 * (case-insensitive) against the bulk list; every definition is then fetched
 * from the detail endpoint because the bulk list can omit ValueList bindings.
 */
export async function resolvePropertyDefs(
  client: MFilesClient,
  refs: PropertyRef[],
): Promise<MFilesPropertyDef[]> {
  let all: MFilesPropertyDef[] | undefined;
  const ids: number[] = [];
  for (const ref of refs) {
    if (typeof ref === "number") {
      ids.push(ref);
      continue;
    }
    all ??= await client.listProperties();
    const matches = all.filter((p) => sameName(p.Name, ref));
    if (matches.length === 0) {
      throw new MFilesToolError(
        `No property definition is named "${ref}".`,
        `Call mfiles_find_by_name with kind="property" and a shorter substring of "${ref}" to find the exact name or ID.`,
      );
    }
    if (matches.length > 1) {
      throw new MFilesToolError(
        `${matches.length} property definitions are named "${ref}": ${matches.map((p) => p.ID).join(", ")}.`,
        "Pass the intended property's ID as a number instead of its name.",
      );
    }
    ids.push(matches[0].ID);
  }
  return Promise.all(ids.map((id) => client.getProperty(id)));
}

/** Exact-name lookup of value list items, cached for the duration of one call. */
export function makeLookupResolver(client: MFilesClient): LookupResolver {
  const cache = new Map<string, Promise<MFilesValueListItem>>();
  return (valueListId, name) => {
    const key = `${valueListId}:${name.trim().toLowerCase()}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = (async () => {
        const candidates = await client.findValueListItems(
          valueListId,
          name.trim(),
        );
        const exact = candidates.filter((i) => sameName(i.Name, name));
        if (exact.length === 1) return exact[0];
        if (exact.length > 1) {
          throw new MFilesToolError(
            `"${name}" matches ${exact.length} items in value list ${valueListId}: ${exact.map((i) => i.ID).join(", ")}.`,
            "Pass the intended item's ID as a number instead of its name.",
          );
        }
        throw new MFilesToolError(
          `No item named "${name}" in value list ${valueListId}.`,
          candidates.length > 0
            ? `Close matches: ${candidates
                .slice(0, 10)
                .map((i) => `${i.Name} (id ${i.ID})`)
                .join(", ")}. Pass an item ID as a number to be exact.`
            : `Call mfiles_get_value_list_items with value_list_id=${valueListId} to see the allowed items.`,
        );
      })();
      cache.set(key, hit);
    }
    return hit;
  };
}

function assertNoDuplicates(defs: MFilesPropertyDef[], what: string): void {
  const seen = new Set<number>();
  for (const d of defs) {
    if (seen.has(d.ID)) {
      throw new MFilesToolError(
        `Property ${d.ID} ("${d.Name}") appears more than once in ${what}.`,
        "List each property once.",
      );
    }
    seen.add(d.ID);
  }
}

interface PlannedSet {
  def: MFilesPropertyDef;
  typedValue: MFilesTypedValue;
  preview: unknown;
}

async function planAssignments(
  client: MFilesClient,
  assignments: PropertyAssignment[],
  existing: Map<number, MFilesTypedValue>,
): Promise<PlannedSet[]> {
  const defs = await resolvePropertyDefs(
    client,
    assignments.map((a) => a.property),
  );
  assertNoDuplicates(defs, "the properties to set");
  const serverAuto = defs.filter((d) => d.UpdateType === MFUpdateType.ServerAuto);
  if (serverAuto.length > 0) {
    throw new MFilesToolError(
      `${serverAuto.map((d) => `"${d.Name}" (property ${d.ID})`).join(", ")} ${serverAuto.length === 1 ? "is" : "are"} maintained by M-Files itself; the server ignores values sent for ${serverAuto.length === 1 ? "it" : "them"}.`,
      "Drop these properties from the request.",
    );
  }
  const resolve = makeLookupResolver(client);
  const planned: PlannedSet[] = [];
  for (let i = 0; i < defs.length; i++) {
    const { typedValue, preview } = await toTypedValue(
      defs[i],
      assignments[i].value,
      resolve,
      { append: assignments[i].append, existing: existing.get(defs[i].ID) },
    );
    planned.push({ def: defs[i], typedValue, preview });
  }
  return planned;
}

export interface UpdateObjectPropertiesArgs {
  objectType: number;
  objectId: number;
  set: PropertyAssignment[];
  remove: PropertyRef[];
  dryRun: boolean;
}

/**
 * Set and/or remove properties on an existing object in one checkout cycle:
 * check out (unless already checked out to us), apply every change, check in.
 * Any failure after checkout undoes the checkout, so nothing is half-applied.
 */
export async function updateObjectProperties(
  client: MFilesClient,
  args: UpdateObjectPropertiesArgs,
) {
  const { objectType, objectId } = args;
  if (args.set.length === 0 && args.remove.length === 0) {
    throw new MFilesToolError(
      "Nothing to change: both set and remove are empty.",
      "Pass at least one property in set or remove.",
    );
  }

  const current = await client.getObjectVersion(objectType, objectId);
  if (current.ObjectCheckedOut && !current.ObjectCheckedOutToThisUser) {
    throw new MFilesToolError(
      `Object ${objectType}/${objectId} is checked out to ${current.CheckedOutToUserName ?? `user ${current.CheckedOutTo}`}.`,
      "Wait until it is checked in (or ask that user to check it in), then retry.",
    );
  }
  const existing = new Map(
    (current.Properties ?? []).map((p) => [p.PropertyDef, p.TypedValue]),
  );

  const planned = await planAssignments(client, args.set, existing);
  const removeDefs = await resolvePropertyDefs(client, args.remove);
  assertNoDuplicates(removeDefs, "the properties to remove");
  for (const d of removeDefs) {
    if (planned.some((p) => p.def.ID === d.ID)) {
      throw new MFilesToolError(
        `Property ${d.ID} ("${d.Name}") is in both set and remove.`,
        "Either set it (null clears the value) or remove it, not both.",
      );
    }
  }
  const toRemove = removeDefs.filter((d) => existing.has(d.ID));
  const notPresent = removeDefs.filter((d) => !existing.has(d.ID));

  const changes = (after?: MFilesExtendedObjectVersion) => {
    const afterById = new Map(
      (after?.Properties ?? []).map((p) => [p.PropertyDef, p.TypedValue]),
    );
    return [
      ...planned.map((p) => ({
        property_id: p.def.ID,
        name: p.def.Name,
        data_type_name: resolveDataTypeName(p.def.DataType),
        action: p.typedValue.HasValue ? "set" : "clear",
        before: summarizeTypedValue(existing.get(p.def.ID)),
        ...(after
          ? { after: summarizeTypedValue(afterById.get(p.def.ID)) }
          : { new_value: p.preview }),
      })),
      ...toRemove.map((d) => ({
        property_id: d.ID,
        name: d.Name,
        data_type_name: resolveDataTypeName(d.DataType),
        action: "remove",
        before: summarizeTypedValue(existing.get(d.ID)),
        ...(after ? { after: null } : {}),
      })),
    ];
  };
  const skipped = notPresent.map((d) => ({
    property_id: d.ID,
    name: d.Name,
    reason: "not on the object, nothing to remove",
  }));

  if (args.dryRun) {
    return {
      dry_run: true,
      object: summarizeObjectVersion(current),
      planned_changes: changes(),
      ...(skipped.length ? { skipped } : {}),
      will_check_out_and_in: !current.ObjectCheckedOutToThisUser,
      _hint:
        "Nothing was written. Call again with dry_run=false to apply these changes.",
    };
  }

  if (planned.length === 0 && toRemove.length === 0) {
    return {
      updated: false,
      object: summarizeObjectVersion(current),
      skipped,
      _hint: "None of the properties to remove are on the object.",
    };
  }

  const alreadyMine = current.ObjectCheckedOutToThisUser === true;
  let version = current.ObjVer.Version;
  if (!alreadyMine) {
    const checkedOut = await client.checkOut(objectType, objectId);
    version = checkedOut.ObjVer.Version;
  }

  let latest: MFilesExtendedObjectVersion | undefined;
  let final: MFilesObjectVersion;
  try {
    if (planned.length > 0) {
      latest = await client.setProperties(
        objectType,
        objectId,
        version,
        planned.map(
          (p): MFilesPropertyValue => ({
            PropertyDef: p.def.ID,
            TypedValue: p.typedValue,
          }),
        ),
      );
    }
    for (const d of toRemove) {
      latest = await client.removeProperty(objectType, objectId, version, d.ID);
    }
    final = alreadyMine
      ? (latest ?? current)
      : await client.checkIn(objectType, objectId, version);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (alreadyMine) {
      throw new MFilesToolError(
        reason,
        "The object was already checked out to you before this call. Changes applied before the failure are still in your checkout; review them in M-Files.",
      );
    }
    try {
      await client.undoCheckout(objectType, objectId, version);
    } catch (undoErr) {
      logError(undoErr);
      throw new MFilesToolError(
        reason,
        `The update failed and the automatic undo-checkout also failed, so object ${objectType}/${objectId} is still checked out to this account. Undo the checkout in M-Files before retrying.`,
      );
    }
    throw new MFilesToolError(
      reason,
      "Nothing was saved: the checkout was undone and the object is unchanged. Fix the values and retry.",
    );
  }

  return {
    updated: true,
    object: summarizeObjectVersion(final),
    changes: changes(latest),
    ...(skipped.length ? { skipped } : {}),
    checked_in: !alreadyMine,
    ...(alreadyMine
      ? {
          _hint:
            "The object was already checked out to you, so it was left checked out. Check it in from M-Files to publish the changes.",
        }
      : {}),
  };
}

/**
 * Required properties of a class that the caller didn't supply and that
 * M-Files won't fill in itself: no automatic value, and a normal update type
 * (classes list server-maintained ones like Created as required too).
 */
async function missingRequired(
  client: MFilesClient,
  cls: MFilesClass,
  supplied: Set<number>,
) {
  const required = (cls.AssociatedPropertyDefs ?? []).filter(
    (a) =>
      a.Required &&
      !supplied.has(a.PropertyDef) &&
      a.PropertyDef !== BuiltInPropertyDef.Class,
  );
  const defs = await Promise.all(
    required.map((a) => client.getProperty(a.PropertyDef)),
  );
  return defs
    .filter(
      (d) =>
        !d.AutomaticValueType &&
        (d.UpdateType ?? MFUpdateType.Normal) === MFUpdateType.Normal,
    )
    .map((d) => ({
      property_id: d.ID,
      name: d.Name,
      data_type_name: resolveDataTypeName(d.DataType),
    }));
}

export interface CreateObjectArgs {
  objectType: number;
  classId: number;
  properties: PropertyAssignment[];
  dryRun: boolean;
}

export async function createObject(
  client: MFilesClient,
  args: CreateObjectArgs,
) {
  const cls = await client.getClass(args.classId);
  if (cls.ObjectType !== args.objectType) {
    throw new MFilesToolError(
      `Class ${cls.ID} ("${cls.Name}") belongs to object type ${cls.ObjectType}, not ${args.objectType}.`,
      `Use object_type_id=${cls.ObjectType}, or pick a class of object type ${args.objectType} via mfiles_list_classes.`,
    );
  }
  if (args.properties.some((p) => p.append)) {
    throw new MFilesToolError(
      "append makes no sense when creating an object.",
      "Drop append; list every item the new object should have.",
    );
  }
  const planned = await planAssignments(client, args.properties, new Map());
  if (planned.some((p) => p.def.ID === BuiltInPropertyDef.Class)) {
    throw new MFilesToolError(
      "Don't pass the Class property in properties.",
      "The class comes from class_id.",
    );
  }
  const missing = await missingRequired(
    client,
    cls,
    new Set(planned.map((p) => p.def.ID)),
  );
  const preview = planned.map((p) => ({
    property_id: p.def.ID,
    name: p.def.Name,
    data_type_name: resolveDataTypeName(p.def.DataType),
    value: p.preview,
  }));

  if (args.dryRun) {
    return {
      dry_run: true,
      object_type: args.objectType,
      class: { id: cls.ID, name: cls.Name },
      properties: preview,
      ...(missing.length ? { missing_required_properties: missing } : {}),
      _hint: missing.length
        ? "M-Files will probably reject this: the class requires the properties listed in missing_required_properties. Add them, then call with dry_run=false."
        : "Nothing was written. Call again with dry_run=false to create the object.",
    };
  }

  const classValue: MFilesPropertyValue = {
    PropertyDef: BuiltInPropertyDef.Class,
    TypedValue: {
      DataType: MFDataType.Lookup,
      HasValue: true,
      Lookup: { Item: cls.ID, Version: -1 },
    },
  };
  let created: MFilesObjectVersion;
  try {
    created = await client.createObject(args.objectType, {
      PropertyValues: [
        classValue,
        ...planned.map((p) => ({
          PropertyDef: p.def.ID,
          TypedValue: p.typedValue,
        })),
      ],
      Files: [],
    });
  } catch (err) {
    if (missing.length === 0) throw err;
    throw new MFilesToolError(
      err instanceof Error ? err.message : String(err),
      `The class requires properties that weren't supplied: ${missing.map((m) => `${m.name} (${m.property_id}, ${m.data_type_name})`).join(", ")}. Add them and retry.`,
    );
  }
  return {
    created: true,
    object: summarizeObjectVersion(created, cls.Name),
    properties: preview,
  };
}

export interface CreateValueListItemArgs {
  valueListId: number;
  name: string;
  ownerItemId?: number;
  parentItemId?: number;
  allowDuplicate: boolean;
  dryRun: boolean;
}

function summarizeItem(item: MFilesValueListItem) {
  return {
    id: item.ID,
    name: item.Name,
    ...(item.HasOwner ? { owner_id: item.OwnerID } : {}),
    ...(item.HasParent ? { parent_id: item.ParentID } : {}),
  };
}

export async function createValueListItem(
  client: MFilesClient,
  args: CreateValueListItemArgs,
) {
  const name = args.name.trim();
  if (!name) {
    throw new MFilesToolError("The item name is empty.", "Pass a non-blank name.");
  }
  const vl = await client.getValueList(args.valueListId);
  if (vl.RealObjectType) {
    throw new MFilesToolError(
      `${vl.ID} ("${vl.Name}") is an object type, not a plain value list; its items are objects.`,
      `Use mfiles_create_object with object_type_id=${vl.ID} instead.`,
    );
  }
  const valueList = { id: vl.ID, name: vl.Name };
  const duplicates = (await client.findValueListItems(vl.ID, name)).filter(
    (i) => sameName(i.Name, name),
  );
  if (duplicates.length > 0 && !args.allowDuplicate) {
    return {
      created: false,
      value_list: valueList,
      existing_items: duplicates.map(summarizeItem),
      _hint:
        "An item with this name already exists, so nothing was created. Use the existing ID, or pass allow_duplicate=true to add another item with the same name.",
    };
  }

  const item = {
    Name: name,
    ValueListID: vl.ID,
    HasOwner: args.ownerItemId !== undefined,
    OwnerID: args.ownerItemId ?? 0,
    HasParent: args.parentItemId !== undefined,
    ParentID: args.parentItemId ?? 0,
  };
  const ownerHint =
    vl.HasOwner && args.ownerItemId === undefined
      ? {
          _hint: `Value list ${vl.ID} has an owner list${typeof vl.OwnerType === "number" ? ` (${vl.OwnerType})` : ""}; if M-Files rejects the item, pass owner_item_id.`,
        }
      : {};

  if (args.dryRun) {
    return {
      dry_run: true,
      value_list: valueList,
      item: summarizeItem({ ID: 0, ...item }),
      ...ownerHint,
    };
  }
  const created = await client.createValueListItem(vl.ID, item);
  return {
    created: true,
    value_list: valueList,
    item: summarizeItem(created),
  };
}

export async function getObject(
  client: MFilesClient,
  objectType: number,
  objectId: number,
  version: number | "latest",
) {
  const ov = await client.getObjectVersion(objectType, objectId, version);
  const [props, cls] = await Promise.all([
    client.listProperties(),
    typeof ov.Class === "number"
      ? client.getClass(ov.Class).catch(() => undefined)
      : undefined,
  ]);
  const names = new Map(props.map((p) => [p.ID, p.Name]));
  const properties = (ov.Properties ?? []).map((pv) =>
    summarizePropertyValue(pv, names.get(pv.PropertyDef)),
  );
  return {
    object: summarizeObjectVersion(ov, cls?.Name),
    property_count: properties.length,
    properties,
  };
}
