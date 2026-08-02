import { describe, expect, test } from 'vitest'
import type { AgentPreset } from './types'
import { applyPostOutput, runWithConcurrency, sanitizeAgentInfoBindings, validateAgentPreset } from './pipeline'

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

    test('accepts selective fan-in across four stages', () => {
        const preset: AgentPreset = {
            id: 'selective-routing', name: 'Selective routing', maxParallel: 3,
            stages: [
                { id: 'stage-1', nodes: [
                    { kind: 'agent', id: 'a', name: 'A', promptPresetId: 'prompt', modelPresetId: 'model', usePromptPresetParams: false, post: { placement: 'append', includeInHistory: false }, agentInfoBindings: {} },
                    { kind: 'agent', id: 'b', name: 'B', promptPresetId: 'prompt', modelPresetId: 'model', usePromptPresetParams: false, post: { placement: 'append', includeInHistory: false }, agentInfoBindings: {} },
                ] },
                { id: 'stage-2', nodes: [
                    { kind: 'agent', id: 'c', name: 'C', promptPresetId: 'prompt', modelPresetId: 'model', usePromptPresetParams: false, post: { placement: 'append', includeInHistory: false }, agentInfoBindings: { prompt: { responses: ['a'] } } },
                ] },
                { id: 'stage-3', nodes: [
                    { kind: 'main', id: 'main', name: 'Main', agentInfoBindings: { prompt: { responses: ['b', 'c'] } } },
                ] },
                { id: 'stage-4', nodes: [
                    { kind: 'agent', id: 'd', name: 'D', promptPresetId: 'prompt', modelPresetId: 'model', usePromptPresetParams: false, post: { placement: 'none', includeInHistory: false }, agentInfoBindings: { prompt: { responses: ['main', 'a'] } } },
                ] },
            ],
        }
        const result = validateAgentPreset(preset, {
            promptPresetIds: new Set(['prompt']), modelPresetIds: new Set(['model']),
        })

        expect(result.errors).toEqual([])
        expect(result.mainStageIndex).toBe(2)
    })

    test('removes missing and no-longer-earlier bindings after structural edits', () => {
        const preset = presetWithStages()
        preset.stages[1].nodes[0].agentInfoBindings.prompt.info.push('deleted-agent')
        const [preStage] = preset.stages.splice(0, 1)
        preset.stages.push(preStage)

        expect(sanitizeAgentInfoBindings(preset)).toBe(2)
        expect(preset.stages[0].nodes[0].agentInfoBindings).toEqual({})
        expect(preset.stages[1].nodes[0].agentInfoBindings).toEqual({ prompt: { info: ['main'] } })
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

    test('applies cumulative prepend, append, replace, and no-effect output exactly', () => {
        let value = applyPostOutput('main', 'top', 'prepend')
        value = applyPostOutput(value, 'bottom', 'append')
        expect(value).toBe('top\n\nmain\n\nbottom')
        expect(applyPostOutput(value, 'replacement', 'replace')).toBe('replacement')
        expect(applyPostOutput(value, 'tool-only output', 'none')).toBe(value)
    })
})
