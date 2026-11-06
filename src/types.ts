/** MFDataType integer values, identical in the REST and COM APIs. */
export const MFDataType = {
  Uninitialized: 0,
  Text: 1,
  Integer: 2,
  Floating: 3,
  Date: 5,
  Time: 6,
  Timestamp: 7,
  Boolean: 8,
  Lookup: 9,
  MultiSelectLookup: 10,
  Integer64: 11,
  FILETIME: 12,
  MultiLineText: 13,
  ACL: 14,
} as const;

export const DataType: Record<number, string> = {
  0: "Uninitialized",
  1: "Text",
  2: "Integer",
  3: "Floating",
  5: "Date",
  6: "Time",
  7: "Timestamp",
  8: "Boolean",
  9: "SingleSelectLookup",
  10: "MultiSelectLookup",
  11: "Integer64",
  12: "FILETIME",
  13: "MultiLineText",
  14: "ACL",
};

export function resolveDataTypeName(dataType: number): string {
  return DataType[dataType] ?? `Unknown(${dataType})`;
}

export function isLookupDataType(dataType: number): boolean {
  return (
    dataType === MFDataType.Lookup || dataType === MFDataType.MultiSelectLookup
  );
}

/**
 * Built-in property definition IDs. Unlike vault-defined IDs these are fixed
 * by M-Files itself (MFBuiltInPropertyDef) and identical in every vault.
 */
export const BuiltInPropertyDef = {
  Class: 100,
} as const;

/** MFUpdateType: who sets a property's value. */
export const MFUpdateType = {
  /** A normal, user-settable property. */
  Normal: 0,
  /** Set and updated by the server; values sent by clients are ignored. */
  ServerAuto: 1,
  /** Set automatically by the client (e.g. Single file); users aren't prompted. */
  ClientAuto: 2,
} as const;

/** MFCheckOutStatus as returned by .../checkedout. */
export const MFCheckOutStatus = {
  CheckedIn: 0,
  CheckedOut: 1,
  CheckedOutToMe: 2,
} as const;

export interface MFilesObjectType {
  ID: number;
  Name: string;
  NamePlural?: string;
  OwnerPropertyDef?: number;
  DefaultPropertyDef?: number;
  HasOwnerType?: boolean;
  OwnerType?: number;
  RealObjectType?: boolean;
  [key: string]: unknown;
}

export interface AssociatedPropertyDef {
  PropertyDef: number;
  Required: boolean;
}

export interface MFilesClass {
  ID: number;
  Name: string;
  ObjectType: number;
  NamePropertyDef?: number;
  AssociatedPropertyDefs?: AssociatedPropertyDef[];
  Workflow?: number;
  ForcedWorkflow?: boolean;
  /** What MFWS actually calls the force-workflow flag (seen on M-Files 25.11). */
  HasForcedWorkflow?: boolean;
  [key: string]: unknown;
}

export interface MFilesWorkflow {
  ID: number;
  Name: string;
  ObjectClass?: number;
  [key: string]: unknown;
}

export interface MFilesWorkflowState {
  ID: number;
  Name: string;
  Selectable?: boolean;
  [key: string]: unknown;
}

export interface MFilesPropertyDef {
  ID: number;
  Name: string;
  DataType: number;
  ValueList?: number;
  BasedOnValueList?: boolean;
  ObjectType?: number;
  AutomaticValueType?: number;
  Predefined?: boolean;
  UpdateType?: number;
  [key: string]: unknown;
}

export interface MFilesValueList {
  ID: number;
  Name: string;
  NamePlural?: string;
  HasOwner?: boolean;
  Owner?: number;
  OwnerType?: number;
  RealObjectType?: boolean;
  CanHaveFiles?: boolean;
  [key: string]: unknown;
}

export interface MFilesValueListItem {
  ID: number;
  Name: string;
  HasOwner?: boolean;
  OwnerID?: number;
  HasParent?: boolean;
  ParentID?: number;
  ValueListID?: number;
  DisplayID?: string;
  [key: string]: unknown;
}

export interface MFilesLookup {
  Item: number;
  Version: number;
  DisplayValue?: string;
  Deleted?: boolean;
  Hidden?: boolean;
}

export interface MFilesTypedValue {
  DataType: number;
  HasValue?: boolean;
  Value?: unknown;
  Lookup?: MFilesLookup | null;
  Lookups?: MFilesLookup[];
  DisplayValue?: string;
  [key: string]: unknown;
}

export interface MFilesPropertyValue {
  PropertyDef: number;
  TypedValue: MFilesTypedValue;
}

export interface MFilesObjVer {
  ID: number;
  Type: number;
  Version: number;
}

export interface MFilesObjectVersion {
  ObjVer: MFilesObjVer;
  Title?: string;
  DisplayID?: string;
  Class?: number;
  CheckedOutTo?: number;
  CheckedOutToUserName?: string;
  ObjectCheckedOut?: boolean;
  ObjectCheckedOutToThisUser?: boolean;
  Deleted?: boolean;
  CreatedUtc?: string;
  LastModifiedUtc?: string;
  [key: string]: unknown;
}

export interface MFilesExtendedObjectVersion extends MFilesObjectVersion {
  Properties?: MFilesPropertyValue[];
}

export interface MFilesObjectCreationInfo {
  PropertyValues: MFilesPropertyValue[];
  Files: unknown[];
}

export interface MFilesAuthResponse {
  Value: string;
  Expiration?: string;
}

export interface MFilesValueListItemsResponse {
  Items: MFilesValueListItem[];
  MoreResults?: boolean;
  [key: string]: unknown;
}

export class MFilesAuthError extends Error {
  readonly kind = "auth";
  constructor(message: string) {
    super(message);
    this.name = "MFilesAuthError";
  }
}

export class MFilesRequestError extends Error {
  readonly kind = "request";
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
    /** The Message field of an MFWS error body, when there was one. */
    readonly serverMessage?: string,
  ) {
    super(message);
    this.name = "MFilesRequestError";
  }
}

/**
 * An error that already knows what the LLM should do next, e.g. bad input
 * caught before anything was sent, or a write that was rolled back.
 */
export class MFilesToolError extends Error {
  readonly kind = "tool";
  constructor(message: string, readonly hint: string) {
    super(message);
    this.name = "MFilesToolError";
  }
}
