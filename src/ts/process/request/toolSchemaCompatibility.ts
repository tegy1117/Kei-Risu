import type { ToolSchemaCompatibility } from 'src/ts/preset/types'
import { safeStructuredClone } from 'src/ts/polyfill'

type JsonSchema = Record<string, any>
type CompositionKey = 'anyOf' | 'oneOf' | 'allOf'

const compositionKeys: CompositionKey[] = ['anyOf', 'oneOf', 'allOf']

function isSchema(value: unknown): value is JsonSchema {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
    return isSchema(schema.properties) ? schema.properties as Record<string, JsonSchema> : {}
}

function schemaRequired(schema: JsonSchema): string[] {
    return Array.isArray(schema.required)
        ? schema.required.filter((key): key is string => typeof key === 'string')
        : []
}

function sameSchema(left: JsonSchema, right: JsonSchema): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

function alternatives(schema: JsonSchema): JsonSchema[] {
    return Array.isArray(schema.anyOf) ? schema.anyOf.filter(isSchema) : [schema]
}

function mergePropertySchema(left: JsonSchema, right: JsonSchema): JsonSchema {
    if (sameSchema(left, right)) return left

    if (
        left.type === 'string'
        && right.type === 'string'
        && Array.isArray(left.enum)
        && Array.isArray(right.enum)
    ) {
        return { ...left, enum: [...new Set([...left.enum, ...right.enum])] }
    }

    const variants: JsonSchema[] = []
    for (const variant of [...alternatives(left), ...alternatives(right)]) {
        if (!variants.some((item) => sameSchema(item, variant))) variants.push(variant)
    }
    return { anyOf: variants }
}

function mergeProperties(
    target: Record<string, JsonSchema>,
    source: Record<string, JsonSchema>,
): void {
    for (const [key, schema] of Object.entries(source)) {
        if (!isSchema(schema)) continue
        target[key] = target[key] ? mergePropertySchema(target[key], schema) : schema
    }
}

function compositionRequired(branches: JsonSchema[], key: CompositionKey): string[] {
    if (branches.length === 0) return []
    if (key === 'allOf') {
        return [...new Set(branches.flatMap(schemaRequired))]
    }
    const [first, ...rest] = branches.map((branch) => new Set(schemaRequired(branch)))
    return [...first].filter((field) => rest.every((required) => required.has(field)))
}

/**
 * Relax a tool input schema to the object-root subset required by providers
 * such as AWS Bedrock. Only root composition is flattened; nested composition
 * remains available to describe conflicting property shapes.
 */
export function flattenToolSchemaRoot(schema: unknown): JsonSchema {
    const source: JsonSchema = isSchema(schema) ? schema : {}
    const result: JsonSchema = { ...source, type: 'object' }
    const properties: Record<string, JsonSchema> = { ...schemaProperties(source) }
    const required = new Set(schemaRequired(source))

    for (const key of compositionKeys) {
        const rawBranches = Array.isArray(source[key]) ? source[key].filter(isSchema) : []
        delete result[key]
        if (rawBranches.length === 0) continue
        const branches = rawBranches.map(flattenToolSchemaRoot)
        for (const branch of branches) mergeProperties(properties, schemaProperties(branch))
        for (const field of compositionRequired(branches, key)) required.add(field)
    }

    result.properties = properties
    const validRequired = [...required].filter((field) => Object.hasOwn(properties, field))
    if (validRequired.length > 0) result.required = validRequired
    else delete result.required
    delete result.items
    return result
}

export function prepareToolSchema(
    schema: unknown,
    compatibility?: ToolSchemaCompatibility,
): unknown {
    const cloned = safeStructuredClone(schema)
    const compatible = compatibility === 'top-level-object'
        ? flattenToolSchemaRoot(cloned)
        : cloned
    return compatible
}
