import { writable } from 'svelte/store'
import type { ToolAppViewMode, ToolAppViewOptions } from './types'
import { claimToolInteraction, releaseToolInteraction } from './interaction'

export interface ToolAppSession {
    id: string
    ownerId: string
    toolId: string
    functionId: string
    title: string
    mode: ToolAppViewMode
    allowExpand: boolean
    minHeight: number
    iframe: HTMLIFrameElement
}

interface OpenToolAppSession extends ToolAppSession {
    onCancel: (reason: string) => void
}

let activeSession: OpenToolAppSession | null = null
let runtimeMount: HTMLElement | null = null
export const toolAppSessionStore = writable<ToolAppSession | null>(null)

export function registerToolAppRuntimeMount(element: HTMLElement) {
    runtimeMount = element
    return () => {
        if (runtimeMount === element) runtimeMount = null
    }
}

export function getToolAppRuntimeMount() {
    return runtimeMount
}

function publicSession(session: OpenToolAppSession): ToolAppSession {
    const { onCancel: _onCancel, ...value } = session
    return value
}

export function openToolAppSession(input: {
    id: string
    ownerId: string
    toolId: string
    functionId: string
    iframe: HTMLIFrameElement
    options: ToolAppViewOptions
    onCancel: (reason: string) => void
}) {
    if (activeSession && activeSession.ownerId !== input.ownerId) throw new Error('interaction_busy')
    if (activeSession) throw new Error('This invocation already has an open Tool App view.')
    const title = input.options.title?.trim()
    if (!title) throw new Error('Tool App title is required.')
    const mode = input.options.mode ?? 'inline'
    if (!['inline', 'modal', 'fullscreen'].includes(mode)) throw new Error(`Unsupported Tool App view mode: ${String(mode)}`)
    if (input.options.allowExpand !== undefined && typeof input.options.allowExpand !== 'boolean') throw new Error('allowExpand must be a boolean.')
    if (input.options.minHeight !== undefined && !Number.isFinite(input.options.minHeight)) throw new Error('minHeight must be a finite number.')
    const minHeight = Math.max(160, Math.min(1200, Math.floor(input.options.minHeight ?? 320)))
    claimToolInteraction('tool-app', input.id, input.ownerId)
    activeSession = {
        ...input,
        title,
        mode,
        allowExpand: input.options.allowExpand !== false,
        minHeight,
    }
    input.iframe.style.display = 'block'
    toolAppSessionStore.set(publicSession(activeSession))
    return { id: input.id, mode: activeSession.mode }
}

export function setToolAppViewMode(id: string, mode: ToolAppViewMode) {
    if (!activeSession || activeSession.id !== id) throw new Error('Tool App session was not found.')
    if (!['inline', 'modal', 'fullscreen'].includes(mode)) throw new Error(`Unsupported Tool App view mode: ${mode}`)
    if (!activeSession.allowExpand && mode !== 'inline') throw new Error('This Tool App does not allow expanded views.')
    activeSession.mode = mode
    toolAppSessionStore.set(publicSession(activeSession))
    return mode
}

export function closeToolAppSession(id: string) {
    if (!activeSession || activeSession.id !== id) return false
    const session = activeSession
    activeSession = null
    session.iframe.style.display = 'none'
    releaseToolInteraction('tool-app', session.id)
    toolAppSessionStore.set(null)
    return true
}

export function cancelToolAppSession(id: string, reason = 'user_cancelled') {
    if (!activeSession || activeSession.id !== id) return false
    const onCancel = activeSession.onCancel
    closeToolAppSession(id)
    onCancel(reason)
    return true
}

export function cancelActiveToolApp(reason = 'view_unmounted') {
    if (!activeSession) return false
    return cancelToolAppSession(activeSession.id, reason)
}

export function cancelToolAppForTool(toolId: string, reason = 'runtime_unloaded') {
    if (!activeSession || activeSession.toolId !== toolId) return false
    return cancelToolAppSession(activeSession.id, reason)
}

export function resetToolAppSessionForTests() {
    if (activeSession) {
        activeSession.iframe.style.display = 'none'
        activeSession = null
    }
    toolAppSessionStore.set(null)
}

export const toolAppGuestBootstrap = String.raw`
(() => {
    const style = document.createElement('style')
    style.textContent =
        ':root{color-scheme:dark;--risu-bg:#17171c;--risu-panel:#222229;--risu-text:#f1f1f4;--risu-muted:#a7a7b1;--risu-border:#3b3b45;--risu-primary:#8b7cff}' +
        '*{box-sizing:border-box}body{margin:0;padding:14px;background:var(--risu-bg);color:var(--risu-text);font:14px/1.45 system-ui,sans-serif}' +
        'button,input,textarea,select{font:inherit;color:inherit}button,input,textarea,select{border:1px solid var(--risu-border);border-radius:8px;background:var(--risu-panel);padding:8px 10px}' +
        'button{cursor:pointer}button:hover{border-color:var(--risu-primary)}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--risu-primary);outline-offset:2px}' +
        '.risu-tool-stack{display:flex;flex-direction:column;gap:12px}.risu-tool-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.risu-tool-field{display:flex;flex-direction:column;gap:5px}.risu-tool-muted{color:var(--risu-muted)}.risu-tool-card{border:1px solid var(--risu-border);border-radius:10px;background:var(--risu-panel);padding:12px}'
    document.head.appendChild(style)
    const make = (tag, options = {}) => {
        const element = document.createElement(tag)
        if (options.className) element.className = options.className
        if (options.text !== undefined) element.textContent = String(options.text)
        if (options.parent) options.parent.appendChild(element)
        return element
    }
    window.RisuToolUI = {
        make,
        stack: (parent = document.body) => make('div', { parent, className: 'risu-tool-stack' }),
        row: (parent) => make('div', { parent, className: 'risu-tool-row' }),
        card: (parent) => make('section', { parent, className: 'risu-tool-card' }),
        button: (parent, label, onClick) => { const el = make('button', { parent, text: label }); el.type = 'button'; el.addEventListener('click', onClick); return el },
        textInput: (parent, options = {}) => { const el = make('input', { parent }); el.type = 'text'; if (options.placeholder) el.placeholder = options.placeholder; if (options.value !== undefined) el.value = options.value; return el },
        textarea: (parent, options = {}) => { const el = make('textarea', { parent }); if (options.placeholder) el.placeholder = options.placeholder; if (options.value !== undefined) el.value = options.value; return el },
        select: (parent, options = []) => { const el = make('select', { parent }); for (const option of options) { const child = make('option', { parent: el, text: option.label ?? option.value }); child.value = String(option.value) } return el },
        numberStepper: (parent, options = {}) => { const row = make('div', { parent, className: 'risu-tool-row' }); const input = make('input', { parent: row }); input.type = 'number'; input.step = String(options.step ?? 1); if (options.min !== undefined) input.min = String(options.min); if (options.max !== undefined) input.max = String(options.max); input.value = String(options.value ?? 0); const change = (delta) => { input.stepUp(delta); input.dispatchEvent(new Event('input', { bubbles: true })) }; const minus = make('button', { parent: row, text: '-' }); minus.type = 'button'; minus.addEventListener('click', () => change(-1)); const plus = make('button', { parent: row, text: '+' }); plus.type = 'button'; plus.addEventListener('click', () => change(1)); return input },
    }
})()
`
