let activeInteraction: { kind: string, id: string } | null = null

export function claimToolInteraction(kind: string, id: string) {
    if (activeInteraction) throw new Error(`Another interactive tool (${activeInteraction.kind}) is already waiting.`)
    activeInteraction = { kind, id }
}

export function releaseToolInteraction(kind: string, id: string) {
    if (activeInteraction?.kind === kind && activeInteraction.id === id) activeInteraction = null
}

export function resetToolInteractionForTests() {
    activeInteraction = null
}
