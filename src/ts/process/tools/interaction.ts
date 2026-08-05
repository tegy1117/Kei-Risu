import { writable } from 'svelte/store'

export interface ToolInteractionClaim {
    kind: string
    id: string
    ownerId: string
    onCancel?: (reason: string) => void
}

const interactionStack: ToolInteractionClaim[] = []
export const toolInteractionStore = writable<ToolInteractionClaim | null>(null)

export function claimToolInteraction(kind: string, id: string, ownerId = id, onCancel?: (reason: string) => void) {
    const active = interactionStack.at(-1)
    if (active && active.ownerId !== ownerId) throw new Error(`Another interactive tool (${active.kind}) is already waiting.`)
    const claim = { kind, id, ownerId, onCancel }
    interactionStack.push(claim)
    toolInteractionStore.set(claim)
}

export function releaseToolInteraction(kind: string, id: string) {
    const index = interactionStack.findIndex((claim) => claim.kind === kind && claim.id === id)
    if (index < 0) return
    interactionStack.splice(index, 1)
    toolInteractionStore.set(interactionStack.at(-1) ?? null)
}

export function cancelToolInteractionsForOwner(ownerId: string, reason: string) {
    const claims = interactionStack.filter((claim) => claim.ownerId === ownerId).reverse()
    for (const claim of claims) {
        if (!interactionStack.includes(claim)) continue
        if (claim.onCancel) claim.onCancel(reason)
        else releaseToolInteraction(claim.kind, claim.id)
    }
}

export function getActiveToolInteraction() {
    return interactionStack.at(-1) ?? null
}

export function resetToolInteractionForTests() {
    interactionStack.length = 0
    toolInteractionStore.set(null)
}
