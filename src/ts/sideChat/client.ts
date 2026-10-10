import { writable, get } from 'svelte/store'
import { authHeader } from '../process/request/jobFetch'
import { withServerDatabaseMutation } from '../globalApi.svelte'
import { startStatus, markPhase, endStatus, requestStatuses } from '../status/requestStatus'
import type { SideChatSession } from './core'

export const sideChatPanel = writable<{ open: boolean, sessionId: string | null, origin?: { characterId: string, chatId: string } }>({ open: false, sessionId: null })
export const sideChatSessions = writable<SideChatSession[]>([])
export const sideChatDetails = writable<Map<string, SideChatSession>>(new Map())
export const sideChatLimit = writable(3)
export const sideChatConnectionError = writable('')
export const isSideRunning = (s: { status: string }) => s?.status === 'queued' || s?.status === 'running'

export async function sideApi(url = '', method = 'GET', body?: unknown): Promise<any> {
    const res = await fetch(`/api/side-chats${url}`, { method, headers: { ...await authHeader(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const result = await res.json()
    if (!res.ok) throw Object.assign(new Error(result.error || `Side chat failed (${res.status})`), { status: res.status })
    return result
}

export function acceptSideSession(session: SideChatSession) {
    sideChatDetails.update(map => new Map(map).set(session.id, session))
    const statusId = `side:${session.id}:${session.requestId}`
    const phase = session.phase === 'postprocessing' ? 'postprocessing' : session.status === 'queued' ? 'queued' : session.status === 'running' ? 'responding' : session.status === 'interrupted' ? 'failed' : session.status === 'idle' ? 'done' : session.status
    if (session.requestId && (!get(requestStatuses).has(statusId) && isSideRunning(session))) startStatus(statusId, { chatId: `side:${session.id}`, kind: 'side', label: session.name, now: session.run?.startedAt || session.updatedAt })
    if (get(requestStatuses).has(statusId)) {
        if (isSideRunning(session)) markPhase(statusId, phase, Date.now())
        else endStatus(statusId, phase as 'done' | 'failed' | 'partial' | 'aborted', { error: session.error, now: session.run?.endedAt || session.updatedAt })
    }
}

export async function refreshSideChats() {
    const result = await sideApi()
    sideChatSessions.set(result.sessions); sideChatLimit.set(result.limit)
    const selected = get(sideChatPanel).sessionId
    for (const summary of result.sessions as SideChatSession[]) {
        const cached = get(sideChatDetails).get(summary.id)
        if (summary.id === selected || isSideRunning(summary) || (cached && cached.updatedAt !== summary.updatedAt)) {
            const detail = await sideApi(`/${summary.id}`)
            acceptSideSession(detail)
        }
    }
    sideChatDetails.update(map => new Map([...map].filter(([id]) => result.sessions.some(s => s.id === id))))
    sideChatConnectionError.set('')
}

export function startSideDiscovery() {
    let stopped = false, pending = false
    const refresh = async () => {
        if (pending || stopped) return
        pending = true
        try { await refreshSideChats() } catch (error) { sideChatConnectionError.set(error.message) } finally { pending = false }
    }
    void refresh()
    const timer = setInterval(refresh, 1000)
    return () => { stopped = true; clearInterval(timer) }
}

export async function setSideChatLimit(value: number) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Use a positive whole number.')
    await withServerDatabaseMutation(() => sideApi('/limit', 'POST', { limit: value }))
    await refreshSideChats()
}

export async function openSideSession(id: string) {
    const session = await sideApi(`/${id}`)
    acceptSideSession(session); sideChatPanel.set({ open: true, sessionId: id })
}
