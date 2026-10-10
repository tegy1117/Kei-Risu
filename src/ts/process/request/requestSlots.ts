import { getDatabase } from '../../storage/database.svelte'
import { forageStorage, flushSaves } from '../../globalApi.svelte'
import { markPhase } from '../../status/requestStatus'

export function managedKeyRef(url: string, headers: Record<string, string> = {}, explicit?: string): string | undefined {
    const pool = getDatabase().apiKeyPool ?? {}
    if (explicit && pool[explicit]?.key) return explicit
    const values = Object.values(headers)
    let params: string[] = []
    try { params = [...new URL(url).searchParams.values()] } catch { /* transport validates URL */ }
    return Object.values(pool).find(entry => entry.key && (
        values.some(value => value === entry.key || value === `Bearer ${entry.key}` || value === `Token ${entry.key}`)
        || params.includes(entry.key)
    ))?.id
}

export async function reserveRequestSlot(apiKeyRef: string, signal?: AbortSignal, statusId?: string) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    // The server owns the limits. Flush an unsaved newly added/edited key before
    // reserving; no credentials or client-supplied limits in the ticket API.
    await flushSaves()
    const headers = { 'content-type': 'application/json', 'risu-auth': await forageStorage.createAuth() }
    const created = await fetch('/api/request-slots', {
        method: 'POST', headers, body: JSON.stringify({ apiKeyRef }), signal,
    })
    const ticket = await created.json() as { id: string, state: string, error?: string }
    if (!created.ok) throw new Error(ticket.error || 'Could not reserve an API request.')
    const cancel = () => { void fetch(`/api/request-slots/${ticket.id}`, { method: 'DELETE', headers, keepalive: true }).catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    const cleanup = () => signal?.removeEventListener('abort', cancel)
    try {
        let state = ticket.state
        while (state === 'queued') {
            if (statusId) markPhase(statusId, 'queued', Date.now())
            await new Promise<void>((resolve, reject) => {
                const stop = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
                const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, 250)
                signal?.addEventListener('abort', stop, { once: true })
                if (signal?.aborted) stop()
            })
            const response = await fetch(`/api/request-slots/${ticket.id}`, { headers, signal })
            const current = await response.json() as typeof ticket
            if (!response.ok || current.state === 'failed' || current.state === 'aborted') throw new Error(current.error || 'API request cancelled.')
            state = current.state
        }
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (statusId) markPhase(statusId, 'connecting', Date.now())
        return { id: ticket.id, cancel, cleanup }
    } catch (error) { cleanup(); cancel(); throw error }
}
