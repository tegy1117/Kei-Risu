import { get } from 'svelte/store'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { getActiveToolInteraction, resetToolInteractionForTests } from './interaction'
import {
    cancelToolAppSession,
    closeToolAppSession,
    openToolAppSession,
    resetToolAppSessionForTests,
    setToolAppViewMode,
    toolAppSessionStore,
} from './toolApp'

function open(ownerId = 'owner-1', onCancel = vi.fn()) {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    return {
        iframe,
        onCancel,
        result: openToolAppSession({
            id: `view-${ownerId}`,
            ownerId,
            toolId: 'tool-1',
            functionId: 'fn-1',
            iframe,
            options: { title: 'Attack', mode: 'inline', allowExpand: true, minHeight: 100 },
            onCancel,
        }),
    }
}

beforeEach(() => {
    resetToolAppSessionForTests()
    resetToolInteractionForTests()
    document.body.replaceChildren()
})

describe('Tool App sessions', () => {
    test('opens one foreground iframe and supports view changes', () => {
        const session = open()
        expect(session.result).toEqual({ id: 'view-owner-1', mode: 'inline' })
        expect(get(toolAppSessionStore)).toMatchObject({ title: 'Attack', minHeight: 160 })
        expect(getActiveToolInteraction()).toMatchObject({ kind: 'tool-app', ownerId: 'owner-1' })
        expect(() => open('owner-2')).toThrow('interaction_busy')
        expect(setToolAppViewMode('view-owner-1', 'fullscreen')).toBe('fullscreen')
        expect(closeToolAppSession('view-owner-1')).toBe(true)
        expect(session.iframe.style.display).toBe('none')
        expect(get(toolAppSessionStore)).toBeNull()
    })

    test('notifies the invocation when the user cancels', () => {
        const session = open()
        expect(cancelToolAppSession('view-owner-1', 'user_cancelled')).toBe(true)
        expect(session.onCancel).toHaveBeenCalledWith('user_cancelled')
    })
})
