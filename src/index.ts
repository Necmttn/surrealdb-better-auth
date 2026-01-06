import { createAdapterFactory, type DBAdapterDebugLogOption } from "better-auth/adapters";
import { jsonify, StringRecordId } from "surrealdb";
import { Surreal } from "surrealdb";

/**
 * SurrealDB adapter configuration
 */
export interface SurrealAdapterConfig {
    /** SurrealDB connection address (e.g., "http://localhost:8000") */
    address: string;
    /** Database username */
    username: string;
    /** Database password */
    password: string;
    /** Namespace to use */
    ns: string;
    /** Database to use */
    db: string;
    /** Enable debug logging */
    debugLogs?: DBAdapterDebugLogOption;
    /** Use plural table names */
    usePlural?: boolean;
}

/**
 * SurrealDB adapter for Better-Auth
 *
 * @example
 * ```typescript
 * import { surrealAdapter } from "surrealdb-better-auth";
 *
 * const auth = betterAuth({
 *     database: surrealAdapter({
 *         address: "http://localhost:8000",
 *         username: "root",
 *         password: "root",
 *         ns: "test",
 *         db: "test",
 *     }),
 * });
 * ```
 */
export const surrealAdapter = (config: SurrealAdapterConfig) => {
    // Connection management
    let db: Surreal | null = null;
    let isConnecting = false;
    let connectionPromise: Promise<Surreal> | null = null;

    const ensureConnection = async (): Promise<Surreal> => {
        if (db) {
            try {
                // Test if connection is still alive
                await db.query("SELECT 1");
                return db;
            } catch {
                // Connection is dead, reset and reconnect
                db = null;
            }
        }

        if (isConnecting && connectionPromise) {
            return connectionPromise;
        }

        isConnecting = true;
        connectionPromise = new Promise((resolve, reject) => {
            const newDb = new Surreal();
            newDb
                .connect(config.address, {
                    namespace: config.ns,
                    database: config.db,
                    auth: {
                        username: config.username,
                        password: config.password,
                    },
                })
                .then(() => {
                    db = newDb;
                    isConnecting = false;
                    connectionPromise = null;
                    resolve(newDb);
                })
                .catch((error) => {
                    isConnecting = false;
                    connectionPromise = null;
                    reject(error);
                });
        });

        return connectionPromise;
    };

    /**
     * Check if a string looks like a SurrealDB RecordId (format: table:id)
     */
    const isRecordIdString = (value: string): boolean => {
        // RecordId format: table:id where table is alphanumeric and id is alphanumeric/uuid
        // e.g., "user:abc123", "session:xyz", "account:microsoft-12345"
        const recordIdPattern = /^[a-zA-Z_][a-zA-Z0-9_]*:[a-zA-Z0-9_\-⟨⟩]+$/;
        return recordIdPattern.test(value);
    };

    /**
     * Check if a field should be treated as containing a RecordId
     * - `id` field always contains RecordIds
     * - Foreign key fields ending in `Id` that reference our tables
     * - `accountId`, `providerId` are NOT RecordIds - they're OAuth string identifiers
     */
    const isRecordIdField = (field: string): boolean => {
        // `id` is always a RecordId
        if (field === "id") return true;
        // Core auth foreign keys
        if (field === "userId" || field === "sessionId") return true;
        // Organization plugin foreign keys
        if (field === "organizationId" || field === "teamId" || field === "inviterId" || field === "invitationId") return true;
        // Member reference
        if (field === "memberId") return true;
        // accountId and providerId are NOT RecordIds - they're OAuth identifiers
        return false;
    };

    /**
     * Serialize a value for SurrealQL queries
     * - RecordId strings (table:id format) in RecordId fields are NOT quoted
     * - Regular strings get JSON-quoted
     * - Dates get converted to ISO strings
     * - Arrays and objects use JSON.stringify
     * - Numbers and booleans are used as-is
     */
    const serializeValue = (value: unknown, field?: string): string => {
        if (value === undefined || value === null) {
            return "NONE";
        }
        if (typeof value === "string") {
            // Only treat as RecordId if:
            // 1. The field is a known RecordId field (id, userId, sessionId)
            // 2. AND the value looks like a RecordId
            if (field && isRecordIdField(field) && isRecordIdString(value)) {
                return value;
            }
            return JSON.stringify(value);
        }
        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }
        if (value instanceof Date) {
            return `d"${value.toISOString()}"`;
        }
        if (Array.isArray(value)) {
            // Pass the field through so array elements are properly handled as RecordIds if needed
            return `[${value.map(v => serializeValue(v, field)).join(", ")}]`;
        }
        if (typeof value === "object" && value !== null) {
            // Check if it's a RecordId (has tb property)
            if ("tb" in value) {
                return jsonify(value);
            }
            return JSON.stringify(value);
        }
        return JSON.stringify(value);
    };

    /**
     * Convert a where clause array to SurrealDB WHERE string
     * Note: Field names are already transformed by the wrapper
     */
    const buildWhereClause = (
        where: Array<{ field: string; value: unknown; operator?: string }>
    ): string => {
        if (!where || where.length === 0) return "";

        return where
            .map((clause) => {
                const field = clause.field;
                const value = clause.value;
                const operator = clause.operator || "eq";

                // Handle null/undefined values
                if (value === undefined || value === null) {
                    return `${field} = NONE`;
                }

                switch (operator) {
                    case "eq":
                        return `${field} = ${serializeValue(value, field)}`;
                    case "ne":
                        return `${field} != ${serializeValue(value, field)}`;
                    case "gt":
                        return `${field} > ${serializeValue(value, field)}`;
                    case "gte":
                        return `${field} >= ${serializeValue(value, field)}`;
                    case "lt":
                        return `${field} < ${serializeValue(value, field)}`;
                    case "lte":
                        return `${field} <= ${serializeValue(value, field)}`;
                    case "in":
                        return `${field} IN ${serializeValue(value, field)}`;
                    case "contains":
                        return `${field} CONTAINS ${serializeValue(value, field)}`;
                    case "starts_with":
                        return `string::starts_with(${field}, ${serializeValue(value, field)})`;
                    case "ends_with":
                        return `string::ends_with(${field}, ${serializeValue(value, field)})`;
                    default:
                        return `${field} = ${serializeValue(value, field)}`;
                }
            })
            .join(" AND ");
    };

    /**
     * Transform field values for SurrealDB
     * - Convert *Id fields to StringRecordId
     */
    const transformValueForDB = (field: string, value: unknown): unknown => {
        if (value === undefined || value === null) {
            return value;
        }

        // Convert foreign key fields to RecordId
        if (field.endsWith("Id") && typeof value === "string" && !field.startsWith("provider") && !field.startsWith("account")) {
            // Extract the referenced model from field name (e.g., "userId" -> "user")
            const refModel = field.slice(0, -2);
            // Don't convert if it's already a RecordId string format
            if (!value.includes(":")) {
                return new StringRecordId(`${refModel}:${value}`);
            }
            return new StringRecordId(value);
        }

        return value;
    };

    return createAdapterFactory({
        config: {
            adapterId: "surrealdb",
            adapterName: "SurrealDB",
            debugLogs: config.debugLogs ?? false,
            usePlural: config.usePlural ?? false,
            supportsJSON: true,
            supportsDates: true,
            supportsBooleans: true,
            supportsNumericIds: false, // SurrealDB uses string RecordIds
            // Let the factory handle joins via multiple queries
            supportsJoin: false,
        },
        adapter: ({ debugLog }) => {
            // Note: The wrapper already handles:
            // - Model name transformation (via getModelName)
            // - Field name transformation (via transformInput/transformWhereClause)
            // - Input/output data transformation
            //
            // Our job is just to execute the DB operations with the already-transformed data.

            return {
                create: async ({ model, data }) => {
                    const conn = await ensureConnection();

                    // Transform foreign key references to RecordIds
                    const transformedData: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(data)) {
                        transformedData[key] = transformValueForDB(key, value);
                    }

                    debugLog?.("create", { model, data: transformedData });

                    const [result] = await conn.create(model, transformedData);

                    if (!result) {
                        throw new SurrealDBError("Failed to create record");
                    }

                    // Transform output - convert RecordId to string
                    const output: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(result)) {
                        output[key] = jsonify(value);
                    }

                    return output;
                },

                findOne: async ({ model, where }) => {
                    const conn = await ensureConnection();
                    const whereClause = buildWhereClause(where);

                    const query = `SELECT * FROM ${model} WHERE ${whereClause} LIMIT 1`;
                    debugLog?.("findOne", { model, query });

                    const [results] = await conn.query<[Record<string, unknown>[]]>(query);
                    const record = results?.[0];

                    if (!record) {
                        return null;
                    }

                    // Transform output - convert RecordId to string
                    const output: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(record)) {
                        output[key] = jsonify(value);
                    }

                    return output;
                },

                findMany: async ({ model, where, limit, offset, sortBy }) => {
                    const conn = await ensureConnection();

                    let query = `SELECT * FROM ${model}`;

                    if (where && where.length > 0) {
                        const whereClause = buildWhereClause(where);
                        query += ` WHERE ${whereClause}`;
                    }

                    if (sortBy) {
                        query += ` ORDER BY ${sortBy.field} ${sortBy.direction.toUpperCase()}`;
                    }

                    if (limit !== undefined) {
                        query += ` LIMIT ${limit}`;
                    }

                    if (offset !== undefined) {
                        query += ` START ${offset}`;
                    }

                    debugLog?.("findMany", { model, query });

                    const [results] = await conn.query<[Record<string, unknown>[]]>(query);

                    // Transform output - convert RecordId to string
                    return (results || []).map((record) => {
                        const output: Record<string, unknown> = {};
                        for (const [key, value] of Object.entries(record)) {
                            output[key] = jsonify(value);
                        }
                        return output;
                    });
                },

                update: async ({ model, where, update }) => {
                    const conn = await ensureConnection();
                    const whereClause = buildWhereClause(where);

                    // Transform foreign key references to RecordIds
                    const transformedUpdate: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(update)) {
                        transformedUpdate[key] = transformValueForDB(key, value);
                    }

                    const query = `UPDATE ${model} MERGE $data WHERE ${whereClause}`;
                    debugLog?.("update", { model, query, data: transformedUpdate });

                    const [results] = await conn.query<[Record<string, unknown>[]]>(query, {
                        data: transformedUpdate,
                    });

                    const record = results?.[0];

                    if (!record) {
                        throw new SurrealDBError("Failed to update record");
                    }

                    // Transform output - convert RecordId to string
                    const output: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(record)) {
                        output[key] = jsonify(value);
                    }

                    return output;
                },

                updateMany: async ({ model, where, update }) => {
                    const conn = await ensureConnection();
                    const whereClause = buildWhereClause(where);

                    // Transform foreign key references to RecordIds
                    const transformedUpdate: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(update)) {
                        transformedUpdate[key] = transformValueForDB(key, value);
                    }

                    const query = `UPDATE ${model} MERGE $data WHERE ${whereClause}`;
                    debugLog?.("updateMany", { model, query, data: transformedUpdate });

                    const [results] = await conn.query<[Record<string, unknown>[]]>(query, {
                        data: transformedUpdate,
                    });

                    return results?.length || 0;
                },

                delete: async ({ model, where }) => {
                    const conn = await ensureConnection();
                    const whereClause = buildWhereClause(where);

                    const query = `DELETE FROM ${model} WHERE ${whereClause}`;
                    debugLog?.("delete", { model, query });

                    await conn.query(query);
                },

                deleteMany: async ({ model, where }) => {
                    const conn = await ensureConnection();
                    const whereClause = buildWhereClause(where);

                    const query = `DELETE FROM ${model} WHERE ${whereClause}`;
                    debugLog?.("deleteMany", { model, query });

                    const [results] = await conn.query<[Record<string, unknown>[]]>(query);
                    return results?.length || 0;
                },

                count: async ({ model, where }) => {
                    const conn = await ensureConnection();

                    let query: string;
                    if (where && where.length > 0) {
                        const whereClause = buildWhereClause(where);
                        query = `SELECT count() FROM ${model} WHERE ${whereClause} GROUP ALL`;
                    } else {
                        query = `SELECT count() FROM ${model} GROUP ALL`;
                    }

                    debugLog?.("count", { model, query });

                    const [results] = await conn.query<[Array<{ count: number }>]>(query);
                    return results?.[0]?.count || 0;
                },

                options: config,
            };
        },
    });
};

/**
 * Custom error class for SurrealDB adapter errors
 */
export class SurrealDBError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SurrealDBError";
    }
}

// Re-export for backwards compatibility
export { SurrealDBError as SurrealDBQueryError };
