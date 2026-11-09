import { strToU8, zlibSync } from 'fflate'
import type { PdfPromptConversionConfig } from '../types'
import type { AdapterChatMessage, AdapterPreparedRequest } from './types'
import { extractErrorMessage, ModelPresetAdapterError, normalizeHttpStatus } from './error'

export const DEFAULT_PDF_RECENT_PERCENT = 20
const CONTINUE_PROMPT = 'Continue the conversation using the role-labelled JSON transcript in the attached PDF. Interpret escaped newlines in message content as newlines.'

export class PdfPromptConversionError extends ModelPresetAdapterError {
    constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
        super('unsupported', `PDF prompt conversion: ${message}`, {
            ...options, retryable: false, fallbackEligible: false,
        })
    }
}

export function resolvePdfRecentPercent(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(100, Math.round(value)))
        : DEFAULT_PDF_RECENT_PERCENT
}

// Operate on copies at the adapter boundary, never on saved history. Structured
// tool/reasoning/image turns are barriers; cache points end a PDF segment so a
// cached prefix stays stable when later turns are appended.
export function convertPdfPromptMessages(
    messages: AdapterChatMessage[],
    config: PdfPromptConversionConfig | undefined,
    signal?: AbortSignal,
): AdapterChatMessage[] {
    if (!config || config.mode === 'off') return messages
    if (!['standard', 'quality', 'max'].includes(config.mode)) {
        throw new PdfPromptConversionError('Invalid conversion mode')
    }
    signal?.throwIfAborted()
    let first = 0
    if (config.mode !== 'max') {
        while (first < messages.length && messages[first].role === 'system') first++
    }
    let end = messages.length
    if (config.mode === 'quality') {
        const percent = resolvePdfRecentPercent(config.recentPlainTextPercent)
        const length = (message: AdapterChatMessage) => Array.from(message.content).length
        const target = messages.slice(first).reduce((sum, message) => sum + length(message), 0) * percent / 100
        let kept = 0
        while (end > first && (kept < target || percent === 100)) kept += length(messages[--end])
    }
    const out: AdapterChatMessage[] = messages.slice(0, first)
    let pending: AdapterChatMessage[] = []
    const flush = () => {
        if (!pending.length) return
        signal?.throwIfAborted()
        try {
            const transcript = JSON.stringify({ messages: pending.map(({ role, name, content }) => ({ role, name, content })) })
            out.push({
                role: 'user', content: CONTINUE_PROMPT,
                documents: [{ kind: 'pdf', mime: 'application/pdf', filename: 'conversation.pdf', base64: toBase64(createNativeTextPdf(transcript)) }],
                ...(pending.at(-1)?.cachePoint ? { cachePoint: true } : {}),
            })
        } catch (cause) {
            throw new PdfPromptConversionError('Could not create a text PDF', { cause })
        }
        pending = []
    }
    for (let index = first; index < end; index++) {
        const message = messages[index]
        if (message.role === 'tool' || message.toolCallId !== undefined || message.toolCalls?.length
            || message.reasoning?.length || message.providerEcho !== undefined || message.images?.length
            || message.documents?.length || !message.content.length) {
            flush()
            out.push(message)
        } else {
            pending.push(message)
            if (message.cachePoint) flush()
        }
    }
    flush()
    out.push(...messages.slice(end))
    signal?.throwIfAborted()
    return out
}

// A deterministic, single-page native-text PDF, following pdf-pod's compact
// Type0/ToUnicode approach. No rasterization or font download is needed. Unicode
// scalar values (including surrogate pairs) map through the PDF's ToUnicode CMap.
export function createNativeTextPdf(text: string): Uint8Array {
    const characters = Array.from(text)
    const codes = new Map<string, number>()
    for (const character of characters) {
        if (!codes.has(character)) codes.set(character, codes.size + 1)
    }
    if (codes.size > 65535) throw new Error('A PDF can contain at most 65,535 distinct characters')
    const hex = (value: number) => value.toString(16).padStart(4, '0')
    const unicodeHex = (character: string) => character.split('').map(unit => hex(unit.charCodeAt(0))).join('')
    const mappings = Array.from(codes, ([character, code]) => `<${hex(code)}> <${unicodeHex(character)}>`)
    let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /KeiUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n'
    for (let i = 0; i < mappings.length; i += 100) {
        const group = mappings.slice(i, i + 100)
        cmap += `${group.length} beginbfchar\n${group.join('\n')}\nendbfchar\n`
    }
    cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend'
    const encoded = characters.map(character => hex(codes.get(character)!)).join('')
    // Keep the full text on-page even for long prompts; the native text layer,
    // rather than the page image, carries the conversation to the provider.
    const size = Math.min(1, 1000 / Math.max(1, characters.length)).toFixed(10)
    const content = `BT\n/F0 ${size} Tf\n36 756 Td\n<${encoded}> Tj\nET`
    const stream = (value: string) => {
        const compressed = zlibSync(strToU8(value), { level: 6 })
        return concat([strToU8(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`), compressed, strToU8('\nendstream')])
    }
    const objects = [
        strToU8('<< /Type /Catalog /Pages 2 0 R >>'),
        strToU8('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        strToU8('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F0 4 0 R >> >> /Contents 8 0 R >>'),
        strToU8('<< /Type /Font /Subtype /Type0 /BaseFont /KeiUnicode /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>'),
        strToU8('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /KeiUnicode /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 500 /CIDToGIDMap /Identity >>'),
        strToU8('<< /Type /FontDescriptor /FontName /KeiUnicode /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>'),
        stream(cmap), stream(content),
    ]
    const chunks = [strToU8('%PDF-1.7\n')]
    let offset = chunks[0].length
    const offsets = [0]
    objects.forEach((object, index) => {
        offsets.push(offset)
        const chunk = concat([strToU8(`${index + 1} 0 obj\n`), object, strToU8('\nendobj\n')])
        chunks.push(chunk)
        offset += chunk.length
    })
    chunks.push(strToU8(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`))
    return concat(chunks)
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
    return out
}

function toBase64(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return btoa(binary)
}

export function requestContainsPdf(prepared: AdapterPreparedRequest): boolean {
    // Inspect attachment shapes, not text mentioning PDFs or unrelated options.
    const messages = [prepared.body.messages, prepared.body.contents].flatMap(value => Array.isArray(value) ? value : [])
    return messages.some(message => {
        const parts = message?.content ?? message?.parts
        return Array.isArray(parts) && parts.some(part =>
            part?.inlineData?.mimeType === 'application/pdf'
            || part?.type === 'document' && part.source?.media_type === 'application/pdf'
            || part?.type === 'file' && typeof part.file?.file_data === 'string'
                && part.file.file_data.startsWith('data:application/pdf;base64,'))
    })
}

export function normalizePdfHttpError(status: number, message: string, prepared: AdapterPreparedRequest): ModelPresetAdapterError {
    const error = normalizeHttpStatus(status, message) ?? new ModelPresetAdapterError('unknown', message, { status })
    if (requestContainsPdf(prepared) && (error.kind === 'invalid-request' || error.kind === 'unsupported'
        || /\bpdf\b|application\/pdf|file[_ -]?(?:data|input)|document (?:input|format|unsupported)/i.test(message))) {
        return new PdfPromptConversionError(message, { status, cause: error })
    }
    return error
}

// Some gateways report rejection inside a successful HTTP/SSE envelope. Do not
// turn a PDF error frame into an empty successful answer or a retryable parse error.
export function throwIfPdfResponseError(raw: unknown, prepared: AdapterPreparedRequest): void {
    if (!raw || typeof raw !== 'object' || !('error' in raw) || !requestContainsPdf(prepared)) return
    const message = extractErrorMessage(JSON.stringify(raw))
    if (message && /\bpdf\b|application\/pdf|file[_ -]?(?:data|input)|document (?:input|format|unsupported)/i.test(message)) {
        throw new PdfPromptConversionError(message)
    }
}

export function configureOpenRouterPdf(prepared: AdapterPreparedRequest, messages: AdapterChatMessage[]): void {
    if (!messages.some(message => message.documents?.length)) return
    if (new URL(prepared.url).hostname !== 'openrouter.ai') return
    const plugins = Array.isArray(prepared.body.plugins) ? prepared.body.plugins : []
    const existing = plugins.find(plugin => plugin && typeof plugin === 'object' && plugin.id === 'file-parser')
    prepared.body.plugins = [
        ...plugins.filter(plugin => !plugin || typeof plugin !== 'object' || plugin.id !== 'file-parser'),
        { ...existing, id: 'file-parser', pdf: { ...existing?.pdf, engine: 'native' } },
    ]
}
