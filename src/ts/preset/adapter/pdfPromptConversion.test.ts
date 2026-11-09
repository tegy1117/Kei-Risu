// @vitest-environment node
import { describe, expect, test, vi } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { AdapterKind, ModelPreset } from '../types'
import type { AdapterChatMessage, AdapterPreparedRequest } from './types'
import {
    convertPdfPromptMessages, createNativeTextPdf, normalizePdfHttpError,
    PdfPromptConversionError, resolvePdfRecentPercent,
    requestContainsPdf,
} from './pdfPromptConversion'
import { previewChatRequest, sendChatRequest, streamChatRequest } from './openaiCompatible'
import { previewAnthropicChatRequest, sendAnthropicChatRequest, streamAnthropicChatRequest } from './anthropicMessages'
import { previewGoogleChatRequest, sendGoogleChatRequest, streamGoogleChatRequest } from './googleGemini'

async function extract(bytes: Uint8Array): Promise<string> {
    const task = getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false })
    try {
        const pdf = await task.promise
        expect(pdf.numPages).toBe(1)
        const page = await pdf.getPage(1)
        const content = await page.getTextContent({ disableNormalization: true })
        return content.items.map(item => 'str' in item ? item.str : '').join('')
    } finally {
        await task.destroy()
    }
}

async function transcript(message: AdapterChatMessage): Promise<AdapterChatMessage[]> {
    const base64 = message.documents![0].base64
    return JSON.parse(await extract(new Uint8Array(Buffer.from(base64, 'base64')))).messages
}

const history: AdapterChatMessage[] = [
    { role: 'system', content: '지시문\n둘째 줄' },
    { role: 'system', content: 'Additional system prompt' },
    { role: 'user', name: '사용자', content: '안녕 😺\n\n가나다 é\t\\ "test"' },
    { role: 'assistant', content: '답변입니다.' },
    { role: 'user', content: '마지막 질문' },
]

function preset(kind: AdapterKind = 'openai-compatible'): ModelPreset {
    return {
        id: 'pdf-test', name: 'PDF test', userValues: {}, createdAt: 0, updatedAt: 0,
        pdfPromptConversion: { mode: 'standard' },
        profileSnapshot: {
            profileId: 'pdf-test', profileVersion: 1, providerBaseId: 'test', providerBaseVersion: 1, adapterKind: kind,
            auth: { kind: 'none', fields: [] }, endpoint: { kind: 'static', url: 'https://test.invalid/v1/models' },
            modelId: 'test-model', schema: [], uiSchema: { groups: [], fields: [] },
            defaults: {}, headerTemplate: {}, capabilities: ['streaming', 'vision', 'tools'],
        },
    }
}

describe('native text PDF', () => {
    test('independent PDF parser restores Unicode, roles and escaped whitespace exactly', async () => {
        const text = JSON.stringify({ messages: history })
        const bytes = createNativeTextPdf(text)
        expect(await extract(bytes)).toBe(text)
        expect(createNativeTextPdf(text)).toEqual(bytes)
    })

    test('long conversations remain extractable on one page', async () => {
        const text = JSON.stringify({ content: '긴 대화 😺\n'.repeat(12000) })
        expect(await extract(createNativeTextPdf(text))).toBe(text)
    })

    test('distinct-character limit fails explicitly instead of losing characters', () => {
        const text = Array.from({ length: 65536 }, (_, index) => String.fromCodePoint(index + 0x10000)).join('')
        expect(() => createNativeTextPdf(text)).toThrow('65,535')
    })
})

describe('prompt conversion policy', () => {
    test('absent and off preserve original messages exactly', () => {
        expect(convertPdfPromptMessages(history, undefined)).toBe(history)
        expect(convertPdfPromptMessages(history, { mode: 'off' })).toBe(history)
    })

    test('standard retains the complete leading system block without mutating history', async () => {
        const original = structuredClone(history)
        const converted = convertPdfPromptMessages(history, { mode: 'standard' })
        expect(converted.slice(0, 2)).toEqual(history.slice(0, 2))
        expect(await transcript(converted[2])).toEqual(history.slice(2))
        expect(history).toEqual(original)
    })

    test('maximum includes system instructions in the role-labelled transcript', async () => {
        const converted = convertPdfPromptMessages(history, { mode: 'max' })
        expect(converted).toHaveLength(1)
        expect(await transcript(converted[0])).toEqual(history)
    })

    test('quality keeps whole recent messages using Unicode character counts', async () => {
        const messages: AdapterChatMessage[] = [
            { role: 'system', content: 'system' },
            { role: 'user', content: '😺'.repeat(80) },
            { role: 'assistant', content: 'a'.repeat(15) },
            { role: 'user', content: 'b'.repeat(5) },
        ]
        const converted = convertPdfPromptMessages(messages, { mode: 'quality' })
        expect(await transcript(converted[1])).toEqual(messages.slice(1, 2))
        expect(converted.slice(2)).toEqual(messages.slice(2))
        expect(convertPdfPromptMessages(messages, { mode: 'quality', recentPlainTextPercent: 0 }))
            .toEqual(convertPdfPromptMessages(messages, { mode: 'standard' }))
        expect(convertPdfPromptMessages(messages, { mode: 'quality', recentPlainTextPercent: 100 })).toEqual(messages)
    })

    test('original structured turns and tool adjacency survive both initial and follow-up requests', () => {
        const structured: AdapterChatMessage[] = [
            { role: 'user', content: 'look', images: [{ kind: 'image', base64: 'AAAA', mime: 'image/png' }] },
            { role: 'assistant', content: '', toolCalls: [{ id: 'call1', name: 'search', arguments: '{}', signature: 'sig' }], reasoning: [{ text: 'thought', signature: 'signed' }] },
            { role: 'tool', content: 'result', toolCallId: 'call1', name: 'search' },
            { role: 'assistant', content: 'echo', providerEcho: { role: 'assistant', reasoning_details: [] } },
        ]
        const messages = [history[2], ...structured, history[4]]
        const converted = convertPdfPromptMessages(messages, { mode: 'max' })
        expect(converted.slice(1, 5)).toEqual(structured)
        expect(convertPdfPromptMessages(converted, { mode: 'max' })).toEqual(converted)
    })

    test('cache boundaries and deterministic cached prefixes survive appended turns', () => {
        const prefix: AdapterChatMessage[] = [history[0], { ...history[2], cachePoint: true }]
        const initial = convertPdfPromptMessages([...prefix, history[4]], { mode: 'standard' })
        const later = convertPdfPromptMessages([...prefix, history[3], history[4]], { mode: 'standard' })
        expect(initial[1].cachePoint).toBe(true)
        expect(later[1]).toEqual(initial[1])
        expect(later[2].cachePoint).toBeUndefined()
    })

    test('empty, system-only and protected-only inputs need no PDF', () => {
        expect(convertPdfPromptMessages([], { mode: 'standard' })).toEqual([])
        expect(convertPdfPromptMessages(history.slice(0, 2), { mode: 'standard' })).toEqual(history.slice(0, 2))
        const protectedMessages: AdapterChatMessage[] = [{ role: 'user', content: '', images: [{ kind: 'image', base64: 'AA==' }] }]
        expect(convertPdfPromptMessages(protectedMessages, { mode: 'max' })).toEqual(protectedMessages)
    })

    test('invalid settings, generation failure and cancellation stop conversion', () => {
        expect(resolvePdfRecentPercent(undefined)).toBe(20)
        expect(resolvePdfRecentPercent(NaN)).toBe(20)
        expect(resolvePdfRecentPercent(101)).toBe(100)
        expect(resolvePdfRecentPercent(-1)).toBe(0)
        expect(() => convertPdfPromptMessages(history, { mode: 'invalid' as 'max' })).toThrow(PdfPromptConversionError)
        const many = Array.from({ length: 65536 }, (_, index) => String.fromCodePoint(index + 0x10000)).join('')
        expect(() => convertPdfPromptMessages([{ role: 'user', content: many }], { mode: 'max' })).toThrow(PdfPromptConversionError)
        const controller = new AbortController()
        controller.abort()
        expect(() => convertPdfPromptMessages(history, { mode: 'max' }, controller.signal)).toThrow(/abort/i)
    })
})

const adapters = [
    { kind: 'openai-compatible', preview: previewChatRequest, send: sendChatRequest, stream: streamChatRequest,
        response: { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
        sse: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n' },
    { kind: 'anthropic-messages', preview: previewAnthropicChatRequest, send: sendAnthropicChatRequest, stream: streamAnthropicChatRequest,
        response: { content: [{ type: 'text', text: 'ok' }] },
        sse: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n' },
    { kind: 'google-gemini', preview: previewGoogleChatRequest, send: sendGoogleChatRequest, stream: streamGoogleChatRequest,
        response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
        sse: 'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n' },
] as const

function pdfData(body: Record<string, unknown>, kind: AdapterKind): string {
    const wire = body as any
    if (kind === 'google-gemini') return wire.contents[0].parts.find((part: any) => part.inlineData?.mimeType === 'application/pdf').inlineData.data
    const parts = wire.messages[0].content
    if (kind === 'anthropic-messages') return parts.find((part: any) => part.type === 'document').source.data
    return parts.find((part: any) => part.type === 'file').file.file_data.split(',')[1]
}

describe.each(adapters)('$kind PDF wire', adapter => {
    test('preview, non-streaming and streaming send the same PDF without changing the selected model', async () => {
        const p = preset(adapter.kind)
        const messages = [history[2]]
        const preview = await adapter.preview(p, { messages })
        expect(await extract(new Uint8Array(Buffer.from(pdfData(preview.body, adapter.kind), 'base64'))))
            .toBe(JSON.stringify({ messages }))
        const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(init!.body as string)
            expect(pdfData(body, adapter.kind)).toBe(pdfData(preview.body, adapter.kind))
            if (adapter.kind !== 'google-gemini') expect(body.model).toBe('test-model')
            return body.stream || adapter.kind === 'google-gemini' && String(_url).includes('streamGenerateContent')
                ? new Response(adapter.sse, { headers: { 'Content-Type': 'text/event-stream' } })
                : new Response(JSON.stringify(adapter.response))
        })
        expect((await adapter.send(p, { messages, fetchImpl })).text).toBe('ok')
        let text = ''
        for await (const delta of adapter.stream(p, { messages, fetchImpl })) text += delta.textDelta
        expect(text).toBe('ok')
        expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    test('PDF rejection stops after one request for both transports', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'PDF input is not supported' } }), { status: 400 }))
        const p = preset(adapter.kind)
        await expect(adapter.send(p, { messages: [history[2]], fetchImpl })).rejects.toMatchObject({ retryable: false, fallbackEligible: false })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        fetchImpl.mockClear()
        await expect((async () => { for await (const _ of adapter.stream(p, { messages: [history[2]], fetchImpl })) { /* drain */ } })())
            .rejects.toBeInstanceOf(PdfPromptConversionError)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    test('off preserves the pre-existing request body', async () => {
        const p = preset(adapter.kind)
        p.pdfPromptConversion = undefined
        const before = await adapter.preview(p, { messages: history })
        p.pdfPromptConversion = { mode: 'off', recentPlainTextPercent: 99 }
        expect(await adapter.preview(p, { messages: history })).toEqual(before)
    })

    test('PDF errors in HTTP 200 JSON and SSE envelopes are terminal errors', async () => {
        const error = { error: { message: 'PDF parsing failed' } }
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify(error)))
        await expect(adapter.send(preset(adapter.kind), { messages: [history[2]], fetchImpl }))
            .rejects.toBeInstanceOf(PdfPromptConversionError)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        const streamFetch = vi.fn(async () => new Response(`event: error\ndata: ${JSON.stringify(error)}\n\n`))
        await expect((async () => { for await (const _ of adapter.stream(preset(adapter.kind), { messages: [history[2]], fetchImpl: streamFetch })) { /* drain */ } })())
            .rejects.toBeInstanceOf(PdfPromptConversionError)
        expect(streamFetch).toHaveBeenCalledTimes(1)
    })
})

test('OpenRouter uses native PDF parsing and retains other plugin configuration', async () => {
    const p = preset()
    p.profileSnapshot.endpoint = { kind: 'static', url: 'https://openrouter.ai/api/v1/chat/completions' }
    p.customBody = { plugins: [{ id: 'other' }, { id: 'file-parser', pdf: { engine: 'mistral-ocr', custom: true } }] }
    const prepared = await previewChatRequest(p, { messages: [history[2]] })
    expect(prepared.body.plugins).toEqual([{ id: 'other' }, { id: 'file-parser', pdf: { engine: 'native', custom: true } }])
})

test('PDF-related server errors are terminal; ordinary network/server errors keep their policy', async () => {
    const prepared = await previewChatRequest(preset(), { messages: [history[2]] })
    expect(normalizePdfHttpError(500, 'PDF parsing failed', prepared)).toBeInstanceOf(PdfPromptConversionError)
    expect(normalizePdfHttpError(500, 'Server unavailable', prepared).retryable).toBe(true)
    const plain: AdapterPreparedRequest = { ...prepared, body: { messages: [{ role: 'user', content: 'plain' }] } }
    expect(normalizePdfHttpError(400, 'PDF is invalid', plain)).not.toBeInstanceOf(PdfPromptConversionError)
})

test('text mentioning application/pdf does not change off-mode error handling', () => {
    const prepared: AdapterPreparedRequest = { method: 'POST', url: 'https://test.invalid', headers: {}, body: { messages: [{ role: 'user', content: 'Explain application/pdf' }] } }
    expect(requestContainsPdf(prepared)).toBe(false)
    expect(normalizePdfHttpError(500, 'PDF documentation unavailable', prepared).retryable).toBe(true)
})

test('PDF attachment detection checks native contents even when custom messages coexist', () => {
    const prepared: AdapterPreparedRequest = { method: 'POST', url: 'https://test.invalid', headers: {}, body: { messages: [{ role: 'user', content: 'custom' }], contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: 'AA==' } }] }] } }
    expect(requestContainsPdf(prepared)).toBe(true)
})
