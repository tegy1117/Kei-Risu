import { writable } from 'svelte/store'
import { v4 } from 'uuid'
import { claimToolInteraction, releaseToolInteraction } from './interaction'

export type DiceKind = 'coin' | 'd4' | 'd6' | 'd10' | 'd20' | 'd100' | 'range'

export interface DiceRollRequest {
    kind: DiceKind
    count?: number
    modifier?: number
    min?: number
    max?: number
    reason?: string
}

export interface DiceRollItem {
    value: number
    label?: string
    dice?: number[]
}

export interface DiceRollResult {
    ok: true
    kind: DiceKind
    count: number
    rolls: DiceRollItem[]
    rawTotal: number
    modifier: number
    total: number
    min?: number
    max?: number
    reason?: string
}

export interface DiceInteraction {
    id: string
    request: Required<Pick<DiceRollRequest, 'kind' | 'count' | 'modifier'>> & Pick<DiceRollRequest, 'min' | 'max' | 'reason'>
    status: 'waiting' | 'rolling'
    result?: DiceRollResult
}

type Resolver = { resolve: (result: DiceRollResult) => void, reject: (error: Error) => void }

export const diceInteractionStore = writable<DiceInteraction | null>(null)
const resolvers = new Map<string, Resolver>()

function normalizeRequest(input: DiceRollRequest): DiceInteraction['request'] {
    const kinds: DiceKind[] = ['coin', 'd4', 'd6', 'd10', 'd20', 'd100', 'range']
    if (!kinds.includes(input.kind)) throw new Error(`Unsupported dice kind: ${input.kind}`)
    const count = input.kind === 'range' ? 1 : (input.count ?? 1)
    const modifier = input.modifier ?? 0
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Dice count must be an integer from 1 to 100.')
    if (!Number.isSafeInteger(modifier)) throw new Error('Dice modifier must be a safe integer.')
    if (input.kind === 'range') {
        if (!Number.isSafeInteger(input.min) || !Number.isSafeInteger(input.max) || input.min! > input.max!) {
            throw new Error('Roulette min and max must be safe integers with min <= max.')
        }
        if (input.max! - input.min! + 1 > Number.MAX_SAFE_INTEGER) throw new Error('Roulette range is too large.')
    }
    return { kind: input.kind, count, modifier, min: input.min, max: input.max, reason: input.reason }
}

export function secureRandomInt(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) throw new Error('Invalid random integer range.')
    const span = max - min + 1
    if (span > Number.MAX_SAFE_INTEGER) throw new Error('Random integer range is too large.')
    const maxSample = 0x20000000000000
    const limit = Math.floor(maxSample / span) * span
    const words = new Uint32Array(2)
    while (true) {
        crypto.getRandomValues(words)
        const sample = (words[0] & 0x1fffff) * 0x100000000 + words[1]
        if (sample < limit) return min + (sample % span)
    }
}

export function rollDice(request: DiceRollRequest, randomInt = secureRandomInt): DiceRollResult {
    const normalized = normalizeRequest(request)
    const rolls: DiceRollItem[] = []
    for (let index = 0; index < normalized.count; index++) {
        if (normalized.kind === 'coin') {
            const value = randomInt(1, 2)
            rolls.push({ value, label: value === 1 ? 'Heads' : 'Tails' })
        } else if (normalized.kind === 'd100') {
            const tens = randomInt(0, 9)
            const ones = randomInt(0, 9)
            const value = tens === 0 && ones === 0 ? 100 : tens * 10 + ones
            rolls.push({ value, dice: [tens, ones] })
        } else if (normalized.kind === 'range') {
            rolls.push({ value: randomInt(normalized.min!, normalized.max!) })
        } else {
            const sides = Number(normalized.kind.slice(1))
            rolls.push({ value: randomInt(1, sides) })
        }
    }
    const rawTotal = rolls.reduce((sum, roll) => sum + roll.value, 0)
    const total = rawTotal + normalized.modifier
    if (!Number.isSafeInteger(total)) throw new Error('Dice total exceeds the safe integer range.')
    return {
        ok: true,
        kind: normalized.kind,
        count: normalized.count,
        rolls,
        rawTotal,
        modifier: normalized.modifier,
        total,
        min: normalized.min,
        max: normalized.max,
        reason: normalized.reason,
    }
}

export function requestDiceRoll(request: DiceRollRequest): Promise<DiceRollResult> {
    const normalized = normalizeRequest(request)
    const id = v4()
    try {
        claimToolInteraction('dice', id)
    } catch (error) {
        return Promise.reject(error)
    }
    diceInteractionStore.set({ id, request: normalized, status: 'waiting' })
    return new Promise((resolve, reject) => resolvers.set(id, { resolve, reject }))
}

export function activateDiceRoll(id: string, revealDelayMs = 800) {
    const resolver = resolvers.get(id)
    if (!resolver) return
    let interaction: DiceInteraction | null = null
    diceInteractionStore.update((current) => {
        if (!current || current.id !== id || current.status !== 'waiting') return current
        const result = rollDice(current.request)
        interaction = { ...current, status: 'rolling', result }
        return interaction
    })
    if (!interaction) return
    setTimeout(() => {
        const active = resolvers.get(id)
        if (!active) return
        resolvers.delete(id)
        releaseToolInteraction('dice', id)
        diceInteractionStore.set(null)
        active.resolve(interaction!.result!)
    }, Math.max(0, revealDelayMs))
}

export function cancelDiceRoll(id: string) {
    const resolver = resolvers.get(id)
    if (!resolver) return
    resolvers.delete(id)
    releaseToolInteraction('dice', id)
    diceInteractionStore.set(null)
    resolver.reject(new Error('user_cancelled'))
}
