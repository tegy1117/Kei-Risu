import { writable } from 'svelte/store'
import { v4 } from 'uuid'
import { claimToolInteraction, releaseToolInteraction } from './interaction'

export interface ChoiceOptionInput {
    label: string
    value?: string
    description?: string
}

export interface ChoiceRequest {
    question: string
    options: Array<string | ChoiceOptionInput>
    reason?: string
}

export interface ChoiceOption {
    label: string
    value: string
    description?: string
}

export type ChoiceResult =
    | { status: 'answered', index: number, label: string, value: string }
    | { status: 'cancelled' }

export interface ChoiceInteraction {
    id: string
    request: { question: string, options: ChoiceOption[], reason?: string }
}

type Resolver = { resolve: (result: ChoiceResult) => void }

export const choiceInteractionStore = writable<ChoiceInteraction | null>(null)
const resolvers = new Map<string, Resolver>()

function normalizeChoiceRequest(request: ChoiceRequest): ChoiceInteraction['request'] {
    if (!request || typeof request !== 'object') throw new Error('Choice request must be an object.')
    const question = typeof request.question === 'string' ? request.question.trim() : ''
    if (!question) throw new Error('Choice question is required.')
    if (!Array.isArray(request.options) || request.options.length < 1 || request.options.length > 20) {
        throw new Error('Choice options must contain 1 to 20 items.')
    }
    const options = request.options.map((option) => {
        if (typeof option === 'string') {
            const label = option.trim()
            if (!label) throw new Error('Choice option labels cannot be empty.')
            return { label, value: option }
        }
        if (!option || typeof option !== 'object') throw new Error('Choice options must be strings or objects.')
        const label = typeof option.label === 'string' ? option.label.trim() : ''
        const value = typeof option.value === 'string' ? option.value : label
        if (!label || !value) throw new Error('Choice option labels and values cannot be empty.')
        if (option.description !== undefined && typeof option.description !== 'string') {
            throw new Error('Choice option descriptions must be text.')
        }
        return { label, value, description: option.description }
    })
    if (new Set(options.map((option) => option.value)).size !== options.length) {
        throw new Error('Choice option values must be unique.')
    }
    if (request.reason !== undefined && typeof request.reason !== 'string') throw new Error('Choice reason must be text.')
    return { question, options, reason: request.reason }
}

export function requestChoice(request: ChoiceRequest): Promise<ChoiceResult> {
    const normalized = normalizeChoiceRequest(request)
    const id = v4()
    claimToolInteraction('choice', id)
    choiceInteractionStore.set({ id, request: normalized })
    return new Promise((resolve) => resolvers.set(id, { resolve }))
}

export function answerChoice(id: string, index: number) {
    const resolver = resolvers.get(id)
    if (!resolver) return
    let option: ChoiceOption | undefined
    choiceInteractionStore.update((current) => {
        if (!current || current.id !== id) return current
        option = current.request.options[index]
        return current
    })
    if (!option) return
    resolvers.delete(id)
    releaseToolInteraction('choice', id)
    choiceInteractionStore.set(null)
    resolver.resolve({ status: 'answered', index, label: option.label, value: option.value })
}

export function cancelChoice(id: string) {
    const resolver = resolvers.get(id)
    if (!resolver) return
    resolvers.delete(id)
    releaseToolInteraction('choice', id)
    choiceInteractionStore.set(null)
    resolver.resolve({ status: 'cancelled' })
}
