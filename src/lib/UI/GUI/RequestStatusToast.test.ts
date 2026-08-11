// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import {
    addBadge,
    clearStatus,
    endStatus,
    startStatus,
    stopStatusTimer,
} from 'src/ts/status/requestStatus'
import RequestStatusToast from './RequestStatusToast.svelte'

let mounted: ReturnType<typeof mount> | null = null

afterEach(async () => {
    if(mounted) await unmount(mounted)
    mounted = null
    clearStatus('agent-run')
    stopStatusTimer()
    document.body.replaceChildren()
})

async function renderStatus() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted = mount(RequestStatusToast, { target, props: { id: 'agent-run' } })
    await tick()
    return target
}

describe('Agent aggregate request status rendering', () => {
    it('renders post-processing as a live main status', async () => {
        startStatus('agent-run', {
            kind: 'main',
            label: 'Main Output',
            phase: 'postprocessing',
            now: Date.now(),
        })

        const target = await renderStatus()

        expect(target.querySelector('.rs-phase')?.textContent).toContain('Post-processing')
        expect(target.querySelector('.rs-card')?.classList.contains('rs-accent-primary')).toBe(true)
        expect(target.querySelector('.rs-dot')?.classList.contains('rs-breathe')).toBe(true)
    })

    it('renders partial as a terminal warning with failed Agent names', async () => {
        startStatus('agent-run', { kind: 'main', label: 'Main Output', now: 0 })
        addBadge('agent-run', {
            key: 'agent-failures',
            text: 'Failed agents: Reviewer, Formatter',
            tone: 'warn',
        })
        endStatus('agent-run', 'partial', { now: 100 })

        const target = await renderStatus()

        expect(target.querySelector('.rs-phase')?.textContent).toContain('Partially completed')
        expect(target.querySelector('.rs-card')?.classList.contains('rs-accent-warning')).toBe(true)
        expect(target.querySelector('.rs-dot')?.classList.contains('rs-dot-warning')).toBe(true)
        expect(target.querySelector('.rs-dot')?.classList.contains('rs-breathe')).toBe(false)
        expect(target.querySelector('.rs-badge-warn')?.textContent).toContain('Reviewer, Formatter')
    })
})
