import {
  MFDataType,
  MFilesToolError,
  resolveDataTypeName,
} from "./types.js";
import type {
  MFilesLookup,
  MFilesPropertyDef,
  MFilesPropertyValue,
  MFilesTypedValue,
  MFilesValueListItem,
} from "./types.js";

/**
 * Values as the LLM sends them. For lookups, numbers are item IDs and strings
 * are item names. null clears the property.
 */
export type FriendlyScalar = string | number | boolean;
export type FriendlyValue = FriendlyScalar | FriendlyScalar[] | null;

/** Resolves a value list item name to the item, or throws MFilesToolError. */
export type LookupResolver = (
  valueListId: number,
  name: string,
) => Promise<MFilesValueListItem>;

export interface ResolvedValue {
  typedValue: MFilesTypedValue;
  /** Normalized, human-readable form of what will be written. */
  preview: unknown;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function label(def: MFilesPropertyDef): string {
  return `"${def.Name}" (property ${def.ID}, ${resolveDataTypeName(def.DataType)})`;
}

function single(def: MFilesPropertyDef, value: FriendlyValue): FriendlyScalar {
  if (Array.isArray(value)) {
    throw new MFilesToolError(
      `${label(def)} takes a single value, got an array.`,
      "Pass one value. Only MultiSelectLookup properties accept arrays.",
    );
  }
  return value as FriendlyScalar;
}

function toNumber(def: MFilesPropertyDef, value: FriendlyScalar): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(n)) {
    throw new MFilesToolError(
      `${label(def)} needs a number, got ${JSON.stringify(value)}.`,
      "Pass a JSON number, e.g. 42 or 3.5.",
    );
  }
  return n;
}

function toInteger(
  def: MFilesPropertyDef,
  value: FriendlyScalar,
  min: number,
  max: number,
): number {
  const n = toNumber(def, value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new MFilesToolError(
      `${label(def)} needs a whole number between ${min} and ${max}, got ${JSON.stringify(value)}.`,
      "Pass an integer without decimals.",
    );
  }
  return n;
}

function toDate(def: MFilesPropertyDef, value: FriendlyScalar): string {
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new MFilesToolError(
      `${label(def)} needs a date as YYYY-MM-DD, got ${JSON.stringify(value)}.`,
      'Pass the date as an ISO calendar date, e.g. "2024-05-31".',
    );
  }
  return s;
}

function toTime(def: MFilesPropertyDef, value: FriendlyScalar): string {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] ?? 0) > 59) {
    throw new MFilesToolError(
      `${label(def)} needs a time as HH:MM or HH:MM:SS, got ${JSON.stringify(value)}.`,
      'Pass a 24-hour time, e.g. "14:30" or "14:30:00".',
    );
  }
  return `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
}

function toTimestamp(def: MFilesPropertyDef, value: FriendlyScalar): string {
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new MFilesToolError(
      `${label(def)} needs an ISO 8601 timestamp, got ${JSON.stringify(value)}.`,
      'Pass a UTC timestamp, e.g. "2024-05-31T14:30:00Z".',
    );
  }
  return s;
}

function toBoolean(def: MFilesPropertyDef, value: FriendlyScalar): boolean {
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (s === "true" || s === "yes") return true;
  if (s === "false" || s === "no") return false;
  throw new MFilesToolError(
    `${label(def)} needs true or false, got ${JSON.stringify(value)}.`,
    "Pass a JSON boolean.",
  );
}

async function toLookup(
  def: MFilesPropertyDef,
  value: FriendlyScalar,
  resolve: LookupResolver,
): Promise<{ lookup: MFilesLookup; preview: { id: number; name?: string } }> {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new MFilesToolError(
        `${label(def)}: ${value} is not a valid item ID.`,
        "Item IDs are positive integers. Pass a string to look the item up by name instead.",
      );
    }
    return { lookup: { Item: value, Version: -1 }, preview: { id: value } };
  }
  if (typeof value === "string" && value.trim() !== "") {
    const valueListId = def.ValueList;
    if (typeof valueListId !== "number" || valueListId <= 0) {
      throw new MFilesToolError(
        `${label(def)} has no value list binding, so "${value}" can't be looked up by name.`,
        "Pass the item ID as a number instead.",
      );
    }
    const item = await resolve(valueListId, value);
    return {
      lookup: { Item: item.ID, Version: -1 },
      preview: { id: item.ID, name: item.Name },
    };
  }
  throw new MFilesToolError(
    `${label(def)} needs an item ID (number) or item name (string), got ${JSON.stringify(value)}.`,
    "Use mfiles_get_value_list_items to see the allowed items.",
  );
}

export function emptyTypedValue(dataType: number): MFilesTypedValue {
  if (dataType === MFDataType.Lookup) {
    return { DataType: dataType, HasValue: false, Lookup: null };
  }
  if (dataType === MFDataType.MultiSelectLookup) {
    return { DataType: dataType, HasValue: false, Lookups: [] };
  }
  return { DataType: dataType, HasValue: false, Value: null };
}

/**
 * Convert an LLM-supplied value into the TypedValue M-Files expects for this
 * property definition. The DataType always comes from the live definition.
 *
 * With `append`, a MultiSelectLookup keeps the items in `existing` and adds the
 * new ones instead of replacing the whole selection.
 */
export async function toTypedValue(
  def: MFilesPropertyDef,
  value: FriendlyValue,
  resolve: LookupResolver,
  options: { append?: boolean; existing?: MFilesTypedValue } = {},
): Promise<ResolvedValue> {
  const dt = def.DataType;
  if (options.append && dt !== MFDataType.MultiSelectLookup) {
    throw new MFilesToolError(
      `append only applies to MultiSelectLookup properties; ${label(def)} is not one.`,
      "Drop append for this property.",
    );
  }
  if (value === null) {
    if (options.append) {
      throw new MFilesToolError(
        `append with a null value does nothing for ${label(def)}.`,
        "Pass the items to add, or drop append to clear the property.",
      );
    }
    return { typedValue: emptyTypedValue(dt), preview: null };
  }

  switch (dt) {
    case MFDataType.Text:
    case MFDataType.MultiLineText: {
      const s = String(single(def, value));
      return { typedValue: { DataType: dt, HasValue: true, Value: s }, preview: s };
    }
    case MFDataType.Integer: {
      const n = toInteger(def, single(def, value), INT32_MIN, INT32_MAX);
      return { typedValue: { DataType: dt, HasValue: true, Value: n }, preview: n };
    }
    case MFDataType.Integer64: {
      const n = toInteger(
        def,
        single(def, value),
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      );
      return { typedValue: { DataType: dt, HasValue: true, Value: n }, preview: n };
    }
    case MFDataType.Floating: {
      const n = toNumber(def, single(def, value));
      return { typedValue: { DataType: dt, HasValue: true, Value: n }, preview: n };
    }
    case MFDataType.Date: {
      const s = toDate(def, single(def, value));
      return { typedValue: { DataType: dt, HasValue: true, Value: s }, preview: s };
    }
    case MFDataType.Time: {
      const s = toTime(def, single(def, value));
      return { typedValue: { DataType: dt, HasValue: true, Value: s }, preview: s };
    }
    case MFDataType.Timestamp: {
      const s = toTimestamp(def, single(def, value));
      return { typedValue: { DataType: dt, HasValue: true, Value: s }, preview: s };
    }
    case MFDataType.Boolean: {
      const b = toBoolean(def, single(def, value));
      return { typedValue: { DataType: dt, HasValue: true, Value: b }, preview: b };
    }
    case MFDataType.Lookup: {
      const { lookup, preview } = await toLookup(def, single(def, value), resolve);
      return {
        typedValue: { DataType: dt, HasValue: true, Lookup: lookup },
        preview,
      };
    }
    case MFDataType.MultiSelectLookup: {
      const values = Array.isArray(value) ? value : [value];
      const resolved = [];
      for (const v of values) resolved.push(await toLookup(def, v, resolve));
      const lookups: MFilesLookup[] = [];
      const preview: Array<{ id: number; name?: string }> = [];
      const seen = new Set<number>();
      if (options.append) {
        for (const l of options.existing?.Lookups ?? []) {
          if (seen.has(l.Item)) continue;
          seen.add(l.Item);
          lookups.push({ Item: l.Item, Version: -1 });
          preview.push({ id: l.Item, name: l.DisplayValue });
        }
      }
      for (const r of resolved) {
        if (seen.has(r.lookup.Item)) continue;
        seen.add(r.lookup.Item);
        lookups.push(r.lookup);
        preview.push(r.preview);
      }
      return {
        typedValue: { DataType: dt, HasValue: lookups.length > 0, Lookups: lookups },
        preview,
      };
    }
    default:
      throw new MFilesToolError(
        `${label(def)} can't be written by this tool.`,
        "Only text, number, date/time, boolean and lookup properties are supported.",
      );
  }
}

/** Compact view of a TypedValue read back from M-Files. */
export function summarizeTypedValue(tv: MFilesTypedValue | undefined) {
  if (!tv) return null;
  const out: Record<string, unknown> = {
    display_value: tv.DisplayValue ?? null,
  };
  if (tv.DataType === MFDataType.Lookup) {
    out.lookup = tv.Lookup
      ? { id: tv.Lookup.Item, name: tv.Lookup.DisplayValue }
      : null;
  } else if (tv.DataType === MFDataType.MultiSelectLookup) {
    out.lookups = (tv.Lookups ?? []).map((l) => ({
      id: l.Item,
      name: l.DisplayValue,
    }));
  } else if (tv.HasValue !== false && tv.Value !== undefined) {
    out.value = tv.Value;
  }
  return out;
}

export function summarizePropertyValue(pv: MFilesPropertyValue, name?: string) {
  const dt = pv.TypedValue?.DataType ?? MFDataType.Uninitialized;
  return {
    id: pv.PropertyDef,
    ...(name !== undefined ? { name } : {}),
    data_type: dt,
    data_type_name: resolveDataTypeName(dt),
    ...summarizeTypedValue(pv.TypedValue),
  };
}
