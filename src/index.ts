import type { FieldType} from 'better-auth/db';
import { getAuthTables } from 'better-auth/db';
import { createAdapter } from "better-auth/adapters";
import type { CreateCustomAdapter } from "better-auth/adapters";
import type { BetterAuthOptions, Where } from 'better-auth/types';
import type { RecordIdValue, Surreal } from 'surrealdb';
import { RecordId, StringRecordId } from 'surrealdb';
import { operatorMap, typeMap } from './utils';

export interface SurrealBetterAuthConfig {
    /**
     * Enable fields with record type. Otherwise, field type is string.
     *
     * Utilizing this may require you to convert string fields
     * to record types beforehand as `generate` does not perform
     * this conversion for you.
     *
     * @default false
     */
    enableRecords?: boolean
    /**
     * Settings pertaining to schema creation and likewise
     * the better-auth cli `generate` function
     */
	generate?: {
		/**
		 * Add the overwrite clause on all statements
		 */
		overwrite?: boolean
		/**
		 * Disables "ON DELETE" record references functionality
		 * such as when surreal<=v2. Only valid when
         * enableRecords is true.
		 *
		 * @default false
		 */
		disableOnDeleteReference?: boolean
		/**
		 * Rounds default times using time::round
		 * 
		 * @default 's' - seconds
		 */
		roundAtTimes?: 's' | 'ms' | false
	}
}

const createTransform = (options: BetterAuthOptions, config?: SurrealBetterAuthConfig) => {
    const schema = getAuthTables(options);

    function getField(model: string, field: string) {
        if (field === "id") {
            return field;
        }
        const f = schema[model].fields[field];
        return f.fieldName || field;
    }

    return {
        convertWhereClause(where: Where[], model: string) {
            const variables: Record<string, any> = {}
            let whereClause = ''
            for (let index=0; index < where.length; index++) {
                const { field, operator, connector } = where[index];
                let { value }: {value: Where['value'] | RecordId | StringRecordId | (string | number | RecordId | StringRecordId)[]} = where[index];
                let str!: string
                switch (operator) {
                    case "in":
                        str = `${field} IN $${model+field}`;
                        break;
                    case "starts_with":
                        str = `string::starts_with(${field}, $${model+field})`;
                        break;
                    case "ends_with":
                        str = `string::ends_with(${field}, $${model+field})`;
                        break;
                    default:
                        str = `${field} ${operatorMap[operator ?? "eq"]} $${model+field}`
                        break;
                }
                if (index < where.length - 1) {
                    str += ` ${connector ?? 'AND'} `
                }

                // Convert field to RecordId
                if (
                    field === 'id'
                    || (field.endsWith('Id') && config?.enableRecords)
                ) {
                    const toRecordId = (v: RecordIdValue) => {
                        return typeof v === 'string' && v.match(/^[a-zA-Z]+:/)
                            ? new StringRecordId(v)
                            : new RecordId(model, v)
                    }
                    if (Array.isArray(value)) {
                        value = value.map((v) => {
                            return typeof v === 'string' || typeof v === 'number'
                                ? toRecordId(v)
                                : v
                        })
                    } else if (typeof value === 'string' || typeof value === 'number') {
                        value = toRecordId(value)
                    }
                }

                variables[model+field] = value
                whereClause += str
            }
            return {
                whereClause,
                variables,
            }
        },
        getField,
    };
};

export const surrealAdapter = (db: Surreal, config?: SurrealBetterAuthConfig) => {
    if (!db) {
        throw new Error("SurrealDB adapter requires a SurrealDB client");
    }

    return createAdapter({
        config: {
            adapterId: "surreal",
            supportsBooleans: true,
            supportsJSON: true,
            supportsDates: true,
            supportsNumericIds: true,
            disableIdGeneration: true,
            customTransformInput: ({ field, data }) => {
                // Attempt to transform a string to a RecordId
                if (
                    config?.enableRecords
                    && (field === 'id' || field.endsWith('Id'))
                    && typeof data === 'string'
                ) {
                    data = new StringRecordId(data)
                }
                return data
            },
            customTransformOutput: ({ data }) => {
                // Convert RecordId to String
                if (data instanceof RecordId) {
                    data = data.toString()
                }
                return data
            }
        },
        adapter: ({ options }) => {
            const { convertWhereClause, getField } = createTransform(options, config);

            return {
                create: async ({ model, data }) => {
                    const [result] = await db.create<any>(model, data);
                    return result;
                },
                findOne: async ({ model, where, select = [] }) => {
                    const idWhereIndex = where.findIndex((val) => val.field === "id")
                    const selectClause = select.length > 0 && select.map((f) => getField(model, f)) || []

                    // Search by id
                    if (idWhereIndex >= 0) {
                        const [id] = where.splice(idWhereIndex, 1)
                        const { whereClause, variables } = convertWhereClause(where, model);
                        const query = select.length > 0
                            ? `SELECT ${selectClause.join(', ')} FROM ONLY ${id.value} ${whereClause.length ? `WHERE ${whereClause}` : ''}`
                            : `SELECT * FROM ONLY ${id.value} ${whereClause.length ? `WHERE ${whereClause}` : ''}`;
                        const [result] = await db.query<[any]>(query, variables)
                        return typeof result === 'object' ? result : null
                    }
                    // Search by where
                    else {
                        const { whereClause, variables } = convertWhereClause(where, model);
                        const query = select.length > 0
                            ? `SELECT ${selectClause.join(', ')} FROM ${model} WHERE ${whereClause} LIMIT 1`
                            : `SELECT * FROM ${model} WHERE ${whereClause} LIMIT 1`;
                        const [result] = await db.query<[any[]]>(query, variables)
                        return result[0];
                    }
                },
                findMany: async ({ model, where, sortBy, limit, offset }) => {
                    let query = `SELECT * FROM ${model}`;
                    let variables: Record<string, any> | undefined
                    if (where) {
                        const {whereClause, variables: _variables} = convertWhereClause(where, model);
                        variables = _variables
                        query += ` WHERE ${whereClause}`;
                    }
                    if (sortBy) {
                        query += ` ORDER BY ${getField(model, sortBy.field)} ${sortBy.direction}`;
                    }
                    if (limit !== undefined) {
                        query += ` LIMIT ${limit}`;
                    }
                    if (offset !== undefined) {
                        query += ` START ${offset}`;
                    }
                    const [results] = await db.query<[any[]]>(query, variables);
                    return results;
                },
                count: async ({ model, where }) => {
                    const { whereClause, variables } = where ? convertWhereClause(where, model) : {};
                    const query = `SELECT count(${whereClause}) FROM ${model} GROUP ALL`;
                    const [result] = await db.query<[any[]]>(query, variables);
                    const res = result[0];
                    return res.count;
                },
                update: async ({ model, where, update }) => {
                    const idWhereIndex = where.findIndex((val) => val.field === "id")
                    if (idWhereIndex > 0) {
                        const [id] = where.splice(idWhereIndex, 1)
                        const { whereClause, variables } = convertWhereClause(where, model);
                        const query = `UPDATE ONLY ${id.value} MERGE $update ${whereClause.length ? `WHERE ${whereClause}` : ''}`
                        const [result] = await db.query<[any]>(query, {
                            ...variables,
                            update,
                        })
                        return typeof result === 'object' ? result : null
                    } else {
                        const { whereClause, variables } = convertWhereClause(where, model);
                        const query = `UPDATE ${model} MERGE $update WHERE ${whereClause}`
                        const [result] = await db.query<[any[]]>(query, {
                            ...variables,
                            update,
                        });
                        return result[0];
                    }
				},
                delete: async ({ model, where }) => {
                    const idWhereIndex = where.findIndex((val) => val.field === "id")
                    if (idWhereIndex > 0) {
                        const [id] = where.splice(idWhereIndex, 1)
                        const { whereClause, variables } = convertWhereClause(where, model);
                        const query = `DELETE ONLY ${id.value} ${whereClause.length ? `WHERE ${whereClause}` : ''} RETURN BEFORE`
                        await db.query<[any]>(query, variables)
                    } else {
                        const { whereClause, variables } = convertWhereClause(where, model);
                        const query = `DELETE ${model} WHERE ${whereClause} RETURN NONE`
                        await db.query<[any[]]>(query, variables);
                    }
                },
                deleteMany: async ({ model, where }) => {
                    const { whereClause, variables } = convertWhereClause(where, model);
                    const [result] = await db.query<[any[]]>(`DELETE FROM ${model} WHERE ${whereClause} RETURN BEFORE`, variables);
                    return result.length;
                },
                updateMany: async ({ model, where, update }) => {
                    const { whereClause, variables } = convertWhereClause(where, model);
                    const [result] = await db.query<[any[]]>(`UPDATE ${model} MERGE ${JSON.stringify(update)} WHERE ${whereClause}`, variables);
                    return result[0];
                },
                createSchema: async ({ file, tables }) => {
                    if (file && !file?.endsWith('.surql')) {
                        throw Error("output file type must be .surql")
                    }
                    let code = ''
                    const overwrite = config?.generate?.overwrite ? "OVERWRITE " : ""
                    const defaultTimeNow = config?.generate?.roundAtTimes === false
                        ? `time::now()`
                        : `time::round(time::now(), 1${config?.generate?.roundAtTimes ?? 's'})`

                    for (const [tablekey, table] of Object.entries(tables)) {
                        const tableName = table.modelName ?? tablekey
                        code += `DEFINE TABLE ${overwrite}${tableName} SCHEMAFULL;\n`

                        for (const [fieldkey, field] of Object.entries(table.fields)) {
                            const fieldName = field.fieldName ?? fieldkey
                            const typeKey = Array.isArray(field.type) ? `${field.type[0]}[]` as FieldType : field.type;
                            let type = typeMap[typeKey as string] ?? "any"

                            if (
                                config?.enableRecords
                                && field.references
                                && field.references.field === 'id'
                            ) {
                                type = (typeKey as string).endsWith("[]")
                                    ? `record<array<${field.references.model}>>`
                                    : `record<${field.references.model}>`
                            }

                            if (!field.required && type !== "any") {
                                type = `option<${type}>`
                            }

                            const fieldDefault = typeof field.defaultValue === "function" ? field.defaultValue() : field.defaultValue;
                            let defaultStr: string | undefined = undefined
                            if (!(fieldDefault === undefined || fieldDefault === null)) {
                                if (fieldkey === "createdAt") {
                                    defaultStr = ` VALUE ${defaultTimeNow} READONLY`
                                } else if (fieldkey === "updatedAt") {
                                    defaultStr = ` VALUE ${defaultTimeNow}`
                                } else if (fieldkey?.endsWith('At')) {
                                    const roundAtTimes = config?.generate?.roundAtTimes
                                    const valueRounded = roundAtTimes !== false ? `time::round($value, 1${roundAtTimes ?? 's'})` : ""
                                    defaultStr = valueRounded.length ? ` VALUE ${valueRounded}` : ""
                                } else {
                                    defaultStr = ` DEFAULT ${fieldDefault}`
                                }
                            }

                            if (
                                config?.enableRecords
                                && field.references?.onDelete
                                && !config?.generate?.disableOnDeleteReference
                            ) {
                                switch (field.references.onDelete) {
                                    case 'set null':
                                        type += ` REFERENCE ON DELETE UNSET`
                                        break;
                                    case 'no action':
                                        type += ` REFERENCE ON DELETE IGNORE`
                                        break;
                                    case 'restrict':
                                        type += ` REFERENCE ON DELETE REJECT`
                                        break;
                                    case 'set default':
                                        type += ` REFERENCE ON DELETE THEN $value = ${fieldDefault}`
                                        break;
                                    case 'cascade':
                                    default:
                                        type += ` REFERENCE ON DELETE CASCADE`
                                        break;
                                }
                            }

                            code += `DEFINE FIELD ${overwrite}${fieldName} ON TABLE ${tableName} TYPE ${type}${defaultStr ?? ""};\n`
                        }

                        code += `\n`
                    }
                    return {
                        code,
                        path: file ?? 'auth.surql',
                    }
                },
            } satisfies ReturnType<CreateCustomAdapter>
        },
    })
};