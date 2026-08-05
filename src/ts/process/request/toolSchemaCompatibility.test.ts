import { describe, expect, test } from 'vitest'
import { flattenToolSchemaRoot, prepareToolSchema } from './toolSchemaCompatibility'

describe('tool schema compatibility', () => {
    test('keeps the existing top-level anyOf when compatibility is disabled', () => {
        const schema = {
            anyOf: [
                { type: 'object', properties: { mode: { type: 'string', enum: ['a'] } }, required: ['mode'] },
                { type: 'object', properties: { mode: { type: 'string', enum: ['b'] } }, required: ['mode'] },
            ],
        }

        expect(prepareToolSchema(schema)).toEqual(schema)
    })

    test('flattens top-level anyOf into a relaxed object schema', () => {
        const schema = {
            anyOf: [
                {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        level: { type: 'string', enum: ['tool'] },
                        policy: { type: 'string' },
                    },
                    required: ['id', 'level', 'policy'],
                },
                {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        level: { type: 'string', enum: ['function'] },
                        functionId: { type: 'string' },
                        policy: { type: 'string' },
                    },
                    required: ['id', 'level', 'functionId', 'policy'],
                },
            ],
        }

        expect(prepareToolSchema(schema, 'top-level-object')).toEqual({
            type: 'object',
            properties: {
                id: { type: 'string' },
                level: { type: 'string', enum: ['tool', 'function'] },
                policy: { type: 'string' },
                functionId: { type: 'string' },
            },
            required: ['id', 'level', 'policy'],
        })
    })

    test('uses required intersection for oneOf and union for allOf', () => {
        const oneOf = flattenToolSchemaRoot({
            oneOf: [
                { type: 'object', properties: { shared: {}, left: {} }, required: ['shared', 'left'] },
                { type: 'object', properties: { shared: {}, right: {} }, required: ['shared', 'right'] },
            ],
        })
        const allOf = flattenToolSchemaRoot({
            allOf: [
                { type: 'object', properties: { left: {} }, required: ['left'] },
                { type: 'object', properties: { right: {} }, required: ['right'] },
            ],
        })

        expect(oneOf.required).toEqual(['shared'])
        expect(oneOf.properties).toHaveProperty('left')
        expect(oneOf.properties).toHaveProperty('right')
        expect(allOf.required).toEqual(['left', 'right'])
    })

    test('keeps conflicting property shapes as nested anyOf', () => {
        const output = flattenToolSchemaRoot({
            anyOf: [
                { type: 'object', properties: { value: { type: 'string' } } },
                { type: 'object', properties: { value: { type: 'number' } } },
            ],
        })

        expect(output).not.toHaveProperty('anyOf')
        expect(output.properties.value).toEqual({
            anyOf: [{ type: 'string' }, { type: 'number' }],
        })
    })

    test('preserves nested composition and does not mutate the source', () => {
        const schema = {
            type: 'object',
            properties: {
                value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            },
        }
        const before = structuredClone(schema)

        expect(prepareToolSchema(schema, 'top-level-object')).toEqual(schema)
        expect(schema).toEqual(before)
    })

    test('falls back to an empty object for a non-object root', () => {
        expect(prepareToolSchema({ type: 'string' }, 'top-level-object')).toEqual({
            type: 'object',
            properties: {},
        })
    })
})
