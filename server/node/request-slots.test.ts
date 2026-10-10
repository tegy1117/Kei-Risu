import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
const { createRequestSlots } = createRequire(import.meta.url)('./request-slots.cjs')

const schedulers: ReturnType<typeof createRequestSlots>[] = []
afterEach(() => { schedulers.splice(0).forEach(s => s.close()); vi.useRealTimers() })
function setup(pool: Record<string, any>, reservationMs?: number) {
    const scheduler = createRequestSlots({ getPool: async () => pool, reservationMs })
    schedulers.push(scheduler)
    return scheduler
}
const key = (id: string, value: string, maxConcurrentRequests = 1) => ({ id, key: value, maxConcurrentRequests })

describe('server-wide API request slots', () => {
    it('holds capacity through response consumption and admits queued requests in FIFO order', async () => {
        const slots = setup({ a: key('a', 'secret') })
        const first = await slots.acquire({ apiKeyRef: 'a' })
        const second = await slots.reserve('a')
        const third = await slots.reserve('a')
        expect(second.state).toBe('queued')
        expect(third.state).toBe('queued')
        expect((await slots.status(second.id)).state).toBe('queued')
        first() // upstream body finished
        expect((await slots.status(second.id)).state).toBe('ready')
        expect((await slots.status(third.id)).state).toBe('queued')
        const finishSecond = await slots.acquire({ apiKeyRef: 'a', ticketId: second.id })
        expect((await slots.status(third.id)).state).toBe('queued')
        finishSecond()
        expect((await slots.status(third.id)).state).toBe('ready')
    })

    it('shares identical credentials across names and transports, while different keys run independently', async () => {
        const slots = setup({ a: key('a', 'same', 2), alias: key('alias', 'same'), b: key('b', 'different') })
        const release = await slots.acquire({ headers: { Authorization: 'Bearer same' }, url: 'https://example.test/chat' })
        expect((await slots.reserve('alias')).state).toBe('queued')
        expect((await slots.reserve('b')).state).toBe('ready')
        release()
    })

    it('admits two requests at a limit of two, and never consumes one reservation twice', async () => {
        const slots = setup({ a: key('a', 'secret', 2) })
        const ticket = await slots.reserve('a')
        const abort = vi.fn()
        const one = await slots.acquire({ apiKeyRef: 'a', ticketId: ticket.id, abort })
        await expect(slots.acquire({ apiKeyRef: 'a', ticketId: ticket.id })).rejects.toThrow('Invalid request reservation')
        expect(abort).not.toHaveBeenCalled()
        const two = await slots.acquire({ apiKeyRef: 'a' })
        expect((await slots.reserve('a')).state).toBe('queued')
        one(); two()
    })

    it('cancels a waiter without starting it and waits for upstream teardown before freeing a running slot', async () => {
        const slots = setup({ a: key('a', 'secret') })
        const ticket = await slots.reserve('a')
        const abort = vi.fn()
        const release = await slots.acquire({ apiKeyRef: 'a', ticketId: ticket.id, abort })
        const waiting = await slots.reserve('a')
        slots.cancel(waiting.id)
        expect((await slots.status(waiting.id)).state).toBe('aborted')
        slots.cancel(ticket.id)
        expect(abort).toHaveBeenCalledOnce()
        expect((await slots.reserve('a')).state).toBe('queued')
        release()
    })

    it('applies changed limits to waiting requests and fails waiters when a credential changes', async () => {
        const pool = { a: key('a', 'secret') }
        const slots = setup(pool)
        const release = await slots.acquire({ apiKeyRef: 'a' })
        const waiting = await slots.reserve('a')
        pool.a.maxConcurrentRequests = 2
        expect((await slots.status(waiting.id)).state).toBe('ready')
        pool.a.key = 'new-secret'
        expect((await slots.status(waiting.id)).state).toBe('failed')
        release()
    })

    it('returns abandoned reservations to the queue and never returns a secret in a ticket', async () => {
        vi.useFakeTimers()
        const slots = setup({ a: key('a', 'do-not-expose') }, 500)
        const first = await slots.reserve('a')
        const second = await slots.reserve('a')
        expect(JSON.stringify(first)).not.toContain('do-not-expose')
        await vi.advanceTimersByTimeAsync(501)
        expect((await slots.status(first.id)).state).toBe('failed')
        expect((await slots.status(second.id)).state).toBe('ready')
    })

    it('reduces available reservations when the limit decreases without interrupting running requests', async () => {
        const pool = { a: key('a', 'secret', 2) }
        const slots = setup(pool)
        const release = await slots.acquire({ apiKeyRef: 'a' })
        const waiting = await slots.reserve('a')
        expect(waiting.state).toBe('ready')
        pool.a.maxConcurrentRequests = 1
        expect((await slots.status(waiting.id)).state).toBe('queued')
        release()
        expect((await slots.status(waiting.id)).state).toBe('ready')
    })

    it('rejects a stale credential after editing a managed key and accepts OAuth for service accounts', async () => {
        const slots = setup({ a: key('a', 'new-secret'), sa: key('sa', '{"private_key":"fixture"}') })
        await expect(slots.acquire({ apiKeyRef: 'a', headers: { authorization: 'Bearer old-secret' } })).rejects.toThrow('no longer match')
        const release = await slots.acquire({ apiKeyRef: 'sa', headers: { authorization: 'Bearer exchanged-token' } })
        release()
    })
})
