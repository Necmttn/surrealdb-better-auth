import type { Where } from "better-auth/types";

export const operatorMap: Record<Required<Where>['operator'], string | null> = {
    "eq": "==",
    "ne": "!=",
    "lt": "<",
    "lte": "<=",
    "gt": ">",
    "gte": ">=",
    "contains": "CONTAINS",
    "in": "IN",
    "not_in": "NOTINSIDE",
    // not operators but functions
    "starts_with": null,
    "ends_with": null,
}

export const typeMap: Record<string, string> = {
    string: "string",
    boolean: "bool",
    number: "number",
    date: "datetime",
    "number[]": "array<number>",
    "string[]": "array<string>",
    json: "array | object"
}
