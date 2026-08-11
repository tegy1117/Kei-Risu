import { alertConfirm } from 'src/ts/alert'
import { fetchNative } from 'src/ts/globalApi.svelte'
import { isLocalNetworkUrl } from 'src/ts/network/localNetwork'
import { getDatabase } from 'src/ts/storage/database.svelte'
import type { ToolHttpMethod, ToolNetworkProfile, ToolSearchResultMapping } from './types'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_RESPONSE_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const HTTP_METHODS = new Set<ToolHttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const SENSITIVE_RAW_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

interface HttpToolArgs {
    profile?: string
    url?: string
    path?: string
    method?: ToolHttpMethod
    query?: Record<string, unknown>
    headers?: Record<string, string>
    body?: unknown
}

interface SearchToolArgs {
    profile: string
    query: string
    count?: number
    offset?: number
}

function settings() {
    const db = getDatabase()
    db.toolNetworkSettings ??= { profiles: [], approvedOrigins: {} }
    db.toolNetworkSettings.profiles ??= []
    db.toolNetworkSettings.approvedOrigins ??= {}
    return db.toolNetworkSettings
}

function profileByName(name: string | undefined, kind: ToolNetworkProfile['kind']) {
    if (!name) return undefined
    return settings().profiles.find((profile) => profile.kind === kind && (profile.id === name || profile.name === name))
}

function checkedUrl(value: string) {
    let url: URL
    try { url = new URL(value) } catch { throw new Error('A valid absolute HTTP(S) URL is required.') }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP(S) URLs are allowed.')
    if (url.username || url.password) throw new Error('Credentials in URLs are not allowed.')
    if (isLocalNetworkUrl(url.toString())) throw new Error('Private, loopback, link-local, and local host URLs are not allowed.')
    return url
}

async function requireOriginApproval(url: URL) {
    const state = settings()
    const stored = state.approvedOrigins[url.origin]
    if (stored === true) return
    if (stored === false) throw new Error(`Network origin ${url.origin} was denied.`)
    const approved = await alertConfirm(`A managed tool wants to access ${url.origin}. Allow this public network origin?`)
    state.approvedOrigins[url.origin] = approved
    if (!approved) throw new Error(`Network origin ${url.origin} was denied.`)
}

function asStringRecord(value: unknown, label: string) {
    if (value === undefined) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
    const result: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== 'string') throw new Error(`${label}.${key} must be text.`)
        result[key] = entry
    }
    return result
}

function replaceTemplate(template: string, values: Record<string, string>, secrets: Record<string, string>) {
    return template
        .replace(/\{\{secret:([^}]+)\}\}/g, (_match, name: string) => secrets[name] ?? '')
        .replace(/\{\{(query|count|offset)\}\}/g, (_match, name: string) => values[name] ?? '')
}

function redact(value: string, secrets: Record<string, string>) {
    let result = value
    for (const secret of Object.values(secrets)) {
        if (secret) result = result.split(secret).join('[REDACTED]')
    }
    return result
}

function resolveMethod(value: unknown, fallback: ToolHttpMethod): ToolHttpMethod {
    const method = String(value ?? fallback).toUpperCase() as ToolHttpMethod
    if (!HTTP_METHODS.has(method)) throw new Error(`Unsupported HTTP method: ${method}`)
    return method
}

function responseLimit(profile?: ToolNetworkProfile) {
    const configured = Number(profile?.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES)
    if (!Number.isFinite(configured)) return DEFAULT_RESPONSE_BYTES
    return Math.max(1024, Math.min(MAX_RESPONSE_BYTES, Math.floor(configured)))
}

function timeout(profile?: ToolNetworkProfile) {
    const configured = Number(profile?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS
    return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.floor(configured)))
}

function appendQuery(url: URL, query: Record<string, unknown>) {
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue
        if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item))
        else url.searchParams.set(key, String(value))
    }
}

async function readLimitedResponse(response: Response, maxBytes: number, secrets: Record<string, string>) {
    if (!response.body) {
        const buffer = new Uint8Array(await response.arrayBuffer())
        const truncated = buffer.byteLength > maxBytes
        const text = redact(new TextDecoder().decode(buffer.slice(0, maxBytes)), secrets)
        return { text, truncated, bytesRead: Math.min(buffer.byteLength, maxBytes) }
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytesRead = 0
    let truncated = false
    while (bytesRead < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = maxBytes - bytesRead
        if (value.byteLength > remaining) {
            chunks.push(value.slice(0, remaining))
            bytesRead += remaining
            truncated = true
            await reader.cancel()
            break
        }
        chunks.push(value)
        bytesRead += value.byteLength
    }
    if (!truncated && bytesRead === maxBytes) {
        const next = await reader.read()
        truncated = !next.done
        if (truncated) await reader.cancel()
    }
    const buffer = new Uint8Array(bytesRead)
    let offset = 0
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
    return { text: redact(new TextDecoder().decode(buffer), secrets), truncated, bytesRead }
}

async function performRequest(url: URL, method: ToolHttpMethod, headers: Record<string, string>, body: string | undefined, profile?: ToolNetworkProfile) {
    const secrets = profile?.secrets ?? {}
    try {
        await requireOriginApproval(url)
        const response = await fetchNative(url.toString(), {
            method,
            headers,
            body: method === 'GET' || method === 'DELETE' ? undefined : body ?? '',
            requestTimeoutMs: timeout(profile),
            networkPolicy: 'public',
        })
        const finalUrl = checkedUrl(response.url || url.toString())
        if (finalUrl.origin !== url.origin) throw new Error(`Cross-origin redirect to ${finalUrl.origin} was blocked.`)
        const content = await readLimitedResponse(response, responseLimit(profile), secrets)
        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            url: redact(finalUrl.toString(), secrets),
            contentType: response.headers.get('content-type') ?? '',
            ...content,
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(redact(message, secrets))
    }
}

export async function executeHttpTool(args: HttpToolArgs) {
    const profile = profileByName(args.profile, 'http')
    if (args.profile && !profile) throw new Error(`HTTP profile ${args.profile} was not found.`)
    const base = profile?.baseUrl ? replaceTemplate(profile.baseUrl, {}, profile.secrets) : undefined
    const url = checkedUrl(args.url ? args.url : args.path && base ? new URL(args.path, base).toString() : base ?? '')
    if (base && url.origin !== checkedUrl(base).origin) throw new Error('Profile requests cannot leave the profile origin.')
    appendQuery(url, args.query && typeof args.query === 'object' && !Array.isArray(args.query) ? args.query : {})
    const method = resolveMethod(args.method, profile?.method ?? 'GET')
    const headers = { ...asStringRecord(profile?.headers, 'profile.headers'), ...asStringRecord(args.headers, 'headers') }
    if (!profile) {
        for (const key of Object.keys(headers)) if (SENSITIVE_RAW_HEADERS.has(key.toLowerCase())) {
            throw new Error(`Header ${key} is only allowed through a saved profile.`)
        }
    }
    const secrets = profile?.secrets ?? {}
    for (const [key, value] of Object.entries(headers)) headers[key] = replaceTemplate(value, {}, secrets)
    const body = args.body === undefined ? profile?.bodyTemplate : typeof args.body === 'string' ? args.body : JSON.stringify(args.body)
    return performRequest(url, method, headers, body ? replaceTemplate(body, {}, secrets) : undefined, profile)
}

function readPath(value: unknown, path: string): unknown {
    if (!path) return value
    return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
        if (!current || typeof current !== 'object') return undefined
        return (current as Record<string, unknown>)[key]
    }, value)
}

function mapSearchResults(data: unknown, mapping: ToolSearchResultMapping) {
    const items = readPath(data, mapping.itemsPath)
    if (!Array.isArray(items)) return undefined
    return items.map((item) => ({
        title: String(readPath(item, mapping.titlePath) ?? ''),
        url: String(readPath(item, mapping.urlPath) ?? ''),
        snippet: String(readPath(item, mapping.snippetPath) ?? ''),
    }))
}

export async function executeSearchTool(args: SearchToolArgs) {
    const profile = profileByName(args.profile, 'search')
    if (!profile) throw new Error(`Search profile ${args.profile} was not found.`)
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) throw new Error('Search query is required.')
    const count = Math.max(1, Math.min(20, Math.floor(Number(args.count ?? 10))))
    const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)))
    const replacements = { query: encodeURIComponent(query), count: String(count), offset: String(offset) }
    const url = checkedUrl(replaceTemplate(profile.urlTemplate ?? profile.baseUrl ?? '', replacements, profile.secrets))
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(profile.headers ?? {})) headers[key] = replaceTemplate(value, replacements, profile.secrets)
    const body = profile.bodyTemplate ? replaceTemplate(profile.bodyTemplate, { ...replacements, query }, profile.secrets) : undefined
    const response = await performRequest(url, resolveMethod(profile.method, 'GET'), headers, body, profile)
    let raw: unknown = response.text
    let warning: string | undefined
    if (response.contentType.includes('json')) {
        try { raw = JSON.parse(response.text) } catch { warning = 'The response declared JSON but could not be parsed.' }
    }
    if (profile.mapping) {
        const results = mapSearchResults(raw, profile.mapping)
        if (results) return { query, results: results.slice(0, count), truncated: response.truncated, status: response.status }
        warning = 'The configured result mapping did not resolve to an array; returning the limited raw response.'
    }
    return { query, raw, warning, truncated: response.truncated, status: response.status }
}

export function listNetworkProfiles(kind: ToolNetworkProfile['kind']) {
    return settings().profiles.filter((profile) => profile.kind === kind).map(({ id, name, description }) => ({ id, name, description }))
}
