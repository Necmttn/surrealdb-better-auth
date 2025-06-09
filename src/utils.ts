import type { FieldAttribute } from "better-auth/db";
import { StringRecordId } from "surrealdb";

function isDateString(dateString: string) {
	const date = new Date(dateString);
	return !isNaN(date.getTime());
}

function shouldConvertToRecordId(fieldName: string | undefined, model?: string): boolean {
	if (!fieldName?.endsWith("Id")) {
		return false;
	}
	
	const excludedFields = ["providerId", "activeOrganizationId"];
	if (excludedFields.includes(fieldName)) {
		return false;
	}
	
	// Special case: accountId should not be converted when model is "account"
	if (fieldName === "accountId" && model === "account") {
		return false;
	}
	
	return true;
}

export function withApplyDefault(
	value: any,
	field: FieldAttribute,
	action: "create" | "update",
	model?: string,
) {
	switch (true) {
		case action === "update":
			return value;

		case value === undefined || value === null:
			if (field.defaultValue) {
				return typeof field.defaultValue === "function"
					? field.defaultValue()
					: field.defaultValue;
			}
			return value;

		case field.references?.model !== undefined:
			return new StringRecordId(value);

		case shouldConvertToRecordId(field.fieldName, model):
			return new StringRecordId(value);

		case typeof value === "string" && isDateString(value):
			return new Date(value);

		default:
			return value;
	}
}
