import { describe, expect, test } from 'vitest'
import type { AgentPreset } from './types'
import { applyPostOutput, runWithConcurrency, validateAgentPreset } from './pipeline'

function presetWithStages(): AgentPreset {
    return {
        id: 'pipeline',
        name: 'Pipeline',
        maxParallel: 3,
        stages: [
            { id: 'pre', nodes: [{
                kind: 'agent', id: 'research', name: 'Research',
                promptPresetId: 'prompt', modelPresetId: 'model', usePromptPresetParams: false,
                post: { placement: 'append', includeInHistory: false }, agentInfoBindings: {},
            }] },
            { id: 'main-stage', nodes: [{
                kind: 'main', id: 'main', name: 'Main', agentInfoBindings: {
                    prompt: { info: ['research'] },
                },
            }] },
            { id: 'post', nodes: [{
                kind: 'agent', id: 'polish', name: 'Polish',
                promptPresetId: 'prompt', modelPresetId: 'model', usePromptPresetParams: false,
                post: { placement: 'replace', includeInHistory: true }, agentInfoBindings: {
                    prompt: { info: ['main'] },
                },
            }] },
        ],
    }
}

describe('agent preset validation', () => {
    test('accepts strictly earlier-stage agent-info bindings', () => {
        const result = validateAgentPreset(presetWithStages(), {
            promptPresetIds: new Set(['prompt']), modelPresetIds: new Set(['model']),
        })
        expect(result.errors).toEqual([])
        expect(result.mainStageIndex).toBe(1)
    })

    test('rejects same-stage and later-stage bindings', () => {
        const preset = presetWithStages()
        const post = preset.stages[2].nodes[0]
        post.agentInfoBindings = { prompt: { info: ['polish'] } }
        const result = validateAgentPreset(preset, {
            promptPresetIds: new Set(['prompt']), modelPresetIds: new Set(['model']),
        })
        expect(result.errors.some((error) => error.includes('earlier stage'))).toBe(true)
    })

    test('blocks dangling worker prompt and model references', () => {
        const result = validateAgentPreset(presetWithStages(), {
            promptPresetIds: new Set(), modelPresetIds: new Set(),
        })
        expect(result.errors.filter((error) => error.includes('Missing prompt preset'))).toHaveLength(2)
        expect(result.errors.filter((error) => error.includes('Missing model preset'))).toHaveLength(2)
    })
})

describe('stage execution primitives', () => {
    test('keeps result order while enforcing the concurrency limit', async () => {
        let active = 0
        let peak = 0
        const releases: Array<() => void> = []
        const resultPromise = runWithConcurrency([0, 1, 2, 3], 2, async (value) => {
            active++
            peak = Math.max(peak, active)
            await new Promise<void>((resolve) => releases.push(resolve))
            active--
            return `result-${value}`
        })
        await Promise.resolve()
        expect(active).toBe(2)
        releases.shift()?.()
        releases.shift()?.()
        await Promise.resolve()
        await Promise.resolve()
        expect(active).toBe(2)
        releases.shift()?.()
        releases.shift()?.()
        expect(await resultPromise).toEqual(['result-0', 'result-1', 'result-2', 'result-3'])
        expect(peak).toBe(2)
    })

    test('applies cumulative prepend, append, and replace exactly', () => {
        let value = applyPostOutput('main', 'top', 'prepend')
        value = applyPostOutput(value, 'bottom', 'append')
        expect(value).toBe('top\n\nmain\n\nbottom')
        expect(applyPostOutput(value, 'replacement', 'replace')).toBe('replacement')
    })
})
