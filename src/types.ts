export const DataType: Record<number, string> = {
  0: "Uninitialized",
  1: "Text",
  2: "Integer",
  3: "Floating",
  5: "Date",
  6: "Time",
  7: "Timestamp",
  8: "SingleSelectLookup",
  9: "MultiSelectLookup",
  10: "MultiLineText",
  11: "Boolean",
  12: "FileReference",
  13: "Integer64",
};

export function resolveDataTypeName(dataType: number): string {
  return DataType[dataType] ?? `Unknown(${dataType})`;
}

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
  [key: string]: unknown;
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
  constructor(message: string, readonly status: number, readonly body?: string) {
    super(message);
    this.name = "MFilesRequestError";
  }
}
