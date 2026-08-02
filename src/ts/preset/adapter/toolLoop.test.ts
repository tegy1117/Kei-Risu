import { describe, expect, test, vi } from 'vitest'
import {
    collectToolStream,
    runToolLoop,
    resolveToolLoopMaxSteps,
    DEFAULT_TOOL_LOOP_MAX_STEPS,
    MAX_TOOL_LOOP_MAX_STEPS,
    type ToolLoopDeps,
} from './toolLoop'
import type { AdapterChatMessage, AdapterChatResponse, AdapterChatStreamDelta, AdapterToolCall } from './types'

const NL2 = String.fromCharCode(10, 10) // blank-line separator the loop joins with

function res(text: string, toolCalls?: AdapterToolCall[]): AdapterChatResponse {
    return { text, toolCalls, raw: {} }
}

function call(id: string, name: string, args = '{}'): AdapterToolCall {
    return { id, name, arguments: args }
}

// A send() that returns the queued responses in order, recording the
// conversation it was handed at each step.
function scriptedSend(responses: AdapterChatResponse[]) {
    const seen: AdapterChatMessage[][] = []
    const send = vi.fn(async (messages: AdapterChatMessage[]) => {
        seen.push(messages.map((m) => ({ ...m })))
        const next = responses.shift()
        if (!next) throw new Error('send called more times than scripted')
        return next
    })
    return { send, seen }
}

const initial: AdapterChatMessage[] = [{ role: 'user', content: 'hi' }]

describe('resolveToolLoopMaxSteps', () => {
    test('uses the default for an unset or invalid value', () => {
        expect(resolveToolLoopMaxSteps(undefined)).toBe(DEFAULT_TOOL_LOOP_MAX_STEPS)
        expect(resolveToolLoopMaxSteps(Number.NaN)).toBe(DEFAULT_TOOL_LOOP_MAX_STEPS)
    })

    test('normalizes configured values to a finite safe range', () => {
        expect(resolveToolLoopMaxSteps(24.9)).toBe(24)
        expect(resolveToolLoopMaxSteps(0)).toBe(1)
        expect(resolveToolLoopMaxSteps(10_000)).toBe(MAX_TOOL_LOOP_MAX_STEPS)
    })
})

describe('runToolLoop', () => {
    test('returns text directly when the model requests no tools', async () => {
        const { send } = scriptedSend([res('just text')])
        const out = await runToolLoop(initial, {
            send,
            executeTool: vi.fn(),
            maxSteps: 8,
        })
        expect(out).toBe('just text')
        expect(send).toHaveBeenCalledTimes(1)
    })

    test('executes a tool call then re-requests with the result appended', async () => {
        const { send, seen } = scriptedSend([
            res('let me check', [call('c1', 'search', '{"q":"x"}')]),
            res('here is the answer'),
        ])
        const executeTool: ToolLoopDeps['executeTool'] = vi.fn(async (c) => ({
            text: `result for ${c.name}`,
        }))
        const out = await runToolLoop(initial, { send, executeTool, maxSteps: 8 })

        // Segments are joined with a blank line (not bare concatenation).
        expect(out).toBe(['let me check', 'here is the answer'].join(NL2))
        expect(executeTool).toHaveBeenCalledTimes(1)
        // Second send must carry: original + assistant{toolCalls} + tool{result}.
        expect(send).toHaveBeenCalledTimes(2)
        const secondConvo = seen[1]
        expect(secondConvo).toHaveLength(3)
        expect(secondConvo[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'search' }] })
        expect(secondConvo[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', name: 'search', content: 'result for search' })
    })

    test('reports model/tool lifecycle events in execution order', async () => {
        const { send } = scriptedSend([res('before', [call('c1', 'clock')]), res('after')])
        const events: string[] = []
        await runToolLoop(initial, {
            send,
            executeTool: async () => ({ text: '12:00', response: { now: '12:00' }, success: true }),
            maxSteps: 8,
            onModelTurn: (response, position) => events.push(`model:${position.step}:${response.text}`),
            onToolStart: (tool, position) => events.push(`start:${position.step}:${position.callIndex}:${tool.name}`),
            onToolFinish: (tool, result) => events.push(`finish:${tool.name}:${result.success}`),
        })
        expect(events).toEqual([
            'model:0:before',
            'start:0:0:clock',
            'finish:clock:true',
            'model:1:after',
        ])
    })

    test('handles parallel tool calls in a single step (ordered results)', async () => {
        const { send, seen } = scriptedSend([
            res('', [call('a', 'alpha'), call('b', 'beta')]),
            res('done'),
        ])
        const executeTool: ToolLoopDeps['executeTool'] = vi.fn(async (c) => ({ text: `R:${c.name}` }))
        const out = await runToolLoop(initial, { send, executeTool, maxSteps: 8 })

        expect(out).toBe('done')
        expect(executeTool).toHaveBeenCalledTimes(2)
        const convo = seen[1]
        // assistant turn carries both calls, followed by both tool results in order.
        expect(convo[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'a' }, { id: 'b' }] })
        expect(convo[2]).toMatchObject({ role: 'tool', toolCallId: 'a', content: 'R:alpha' })
        expect(convo[3]).toMatchObject({ role: 'tool', toolCallId: 'b', content: 'R:beta' })
    })

    test('appends encoded markers in turn order when executeTool persists them', async () => {
        const marker = '<tool_call>persisted-id</tool_call>'
        const { send } = scriptedSend([
            res('think', [call('c1', 'search')]),
            res('answer'),
        ])
        const executeTool: ToolLoopDeps['executeTool'] = vi.fn(async () => ({
            text: 'tool out',
            encoded: marker,
        }))
        const out = await runToolLoop(initial, { send, executeTool, maxSteps: 8 })
        expect(out.split(NL2)).toEqual(['think', marker, 'answer'])
    })

    test('stops with a marker when the step cap is reached', async () => {
        // Model keeps asking for tools forever; cap at 2 means 2 executions then stop.
        const responses: AdapterChatResponse[] = Array.from({ length: 10 }, () =>
            res('again', [call('c', 'loop')]),
        )
        const { send } = scriptedSend(responses)
        const executeTool: ToolLoopDeps['executeTool'] = vi.fn(async () => ({ text: 'x' }))
        const out = await runToolLoop(initial, { send, executeTool, maxSteps: 2 })

        // steps 0 and 1 execute; step 2 sees calls but hits the cap and stops.
        expect(executeTool).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenCalledTimes(3)
        expect(out).toContain('[ModelPreset: maximum tool steps (2) reached]')
    })

    test('surfaces tool error text (missing tool / bad JSON / failure) as the result', async () => {
        const { send, seen } = scriptedSend([
            res('', [call('c1', 'ghost')]),
            res('ok'),
        ])
        const executeTool: ToolLoopDeps['executeTool'] = vi.fn(async () => ({
            text: 'No tool found with name: ghost',
        }))
        const out = await runToolLoop(initial, { send, executeTool, maxSteps: 8 })
        expect(out).toBe('ok')
        expect(seen[1][2]).toMatchObject({ role: 'tool', content: 'No tool found with name: ghost' })
    })

    test('returns partial result on follow-up failure after tools ran (no outer re-run)', async () => {
        // After a tool executes, a failed follow-up must NOT throw — throwing
        // would let the outer retry loop replay the prompt and re-run the tool.
        const executeTool = vi.fn(async () => ({ text: 'r' }))
        const send = vi.fn()
            .mockResolvedValueOnce(res('first', [call('c1', 'x')]))
            .mockRejectedValueOnce(new Error('network down'))
        const out = await runToolLoop(initial, { send, executeTool, maxSteps: 8 })
        expect(out).toContain('first')
        expect(out).toContain('follow-up request failed')
        expect(executeTool).toHaveBeenCalledTimes(1) // ran once, not re-run
    })

    test('returns partial (no throw) when executeTool fails after a side effect', async () => {
        // The tool already ran inside executeTool; a later failure (e.g. its
        // persistence write) must not bubble to the outer retry loop.
        const { send } = scriptedSend([
            res('before', [call('c1', 'writer')]),
            res('after'),
        ])
        const executeTool = vi.fn().mockRejectedValueOnce(new Error('encode died'))
        const out = await runToolLoop(initial, { send, executeTool, maxSteps: 8 })
        expect(out).toContain('before')
        expect(out).toContain('tool execution failed')
        expect(executeTool).toHaveBeenCalledTimes(1)
        expect(send).toHaveBeenCalledTimes(1) // did NOT re-request after the failure
    })

    test('rethrows a first-send failure (nothing executed yet, safe to retry)', async () => {
        const executeTool = vi.fn()
        const send = vi.fn().mockRejectedValueOnce(new Error('boom'))
        await expect(
            runToolLoop(initial, { send, executeTool, maxSteps: 8 }),
        ).rejects.toThrow('boom')
        expect(executeTool).not.toHaveBeenCalled()
    })

    test('stops launching tools mid-batch once aborted (no further side effects)', async () => {
        // Parallel batch of two write-side tools; the user cancels while the first
        // runs. The second must NOT fire, and the loop returns partial (no re-run).
        const controller = new AbortController()
        const { send } = scriptedSend([
            res('', [call('a', 'writerA'), call('b', 'writerB')]),
            res('should-not-reach'),
        ])
        let ran = 0
        const executeTool = vi.fn(async () => { ran++; controller.abort(); return { text: 'ok' } })
        const out = await runToolLoop(initial, { send, executeTool, maxSteps: 8, abortSignal: controller.signal })
        expect(ran).toBe(1)                       // only the first tool ran
        expect(executeTool).toHaveBeenCalledTimes(1)
        expect(out).toContain('aborted before completing tool calls')
        expect(send).toHaveBeenCalledTimes(1)     // did NOT re-request after abort
    })

    test('launches no tools when already aborted before the batch', async () => {
        const controller = new AbortController()
        controller.abort()
        const { send } = scriptedSend([res('text', [call('a', 'writer')])])
        const executeTool = vi.fn(async () => ({ text: 'ok' }))
        const out = await runToolLoop(initial, { send, executeTool, maxSteps: 8, abortSignal: controller.signal })
        expect(executeTool).not.toHaveBeenCalled()
        expect(out).toContain('aborted before completing tool calls')
    })

    test('does not mutate the caller-provided initial messages', async () => {
        const { send } = scriptedSend([res('hi')])
        const frozen = [...initial]
        await runToolLoop(initial, { send, executeTool: vi.fn(), maxSteps: 8 })
        expect(initial).toEqual(frozen)
    })

    test('formatReasoning is prepended to each turn segment when provided', async () => {
        const withReasoning: AdapterChatResponse = { text: 'visible', reasoning: [{ text: 'chain' }], raw: {} }
        const { send } = scriptedSend([withReasoning])
        const out = await runToolLoop(initial, {
            send,
            executeTool: vi.fn(),
            maxSteps: 8,
            formatReasoning: (r) => (r && r.length > 0 ? `<T>${r[0].text}</T>\n` : ''),
        })
        expect(out).toBe('<T>chain</T>\nvisible')
    })

    test('reasoning is ignored in output when no formatReasoning is injected', async () => {
        const withReasoning: AdapterChatResponse = { text: 'visible', reasoning: [{ text: 'chain' }], raw: {} }
        const { send } = scriptedSend([withReasoning])
        const out = await runToolLoop(initial, { send, executeTool: vi.fn(), maxSteps: 8 })
        expect(out).toBe('visible')
    })
})

describe('collectToolStream', () => {
    test('assembles visible deltas, structured tool calls, reasoning and usage', async () => {
        async function* stream(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
            yield { textDelta: 'before ', reasoningDelta: 'think ', usage: { promptTokens: 4 }, raw: { n: 1 } }
            yield { textDelta: 'tool', reasoningDelta: 'first', usage: { completionTokens: 3 }, raw: { n: 2 } }
            yield {
                textDelta: '',
                toolCalls: [call('c1', 'clock', '{"zone":"UTC"}')],
                reasoning: [{ text: 'think first', signature: 'sig' }],
                providerEcho: [{ functionCall: { name: 'clock' } }],
                finishReason: 'tool_calls',
                raw: { n: 3 },
            }
        }
        const seen: string[] = []
        const response = await collectToolStream(stream(), (delta) => seen.push(delta.textDelta))
        expect(response.text).toBe('before tool')
        expect(response.toolCalls).toEqual([call('c1', 'clock', '{"zone":"UTC"}')])
        expect(response.reasoning).toEqual([{ text: 'think first', signature: 'sig' }])
        expect(response.usage).toEqual({ promptTokens: 4, completionTokens: 3 })
        expect(response.finishReason).toBe('tool_calls')
        expect(seen).toEqual(['before ', 'tool', ''])
    })

    test('does not send a follow-up model request when the only tool aborts', async () => {
        const controller = new AbortController()
        const { send } = scriptedSend([
            res('before', [call('a', 'question')]),
            res('should-not-reach'),
        ])
        const executeTool = vi.fn(async () => {
            controller.abort()
            return { text: 'cancelled' }
        })
        const out = await runToolLoop(initial, {
            send, executeTool, maxSteps: 8, abortSignal: controller.signal,
        })
        expect(send).toHaveBeenCalledTimes(1)
        expect(out).toContain('aborted after tool execution')
    })
})
