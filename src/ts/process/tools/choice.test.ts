import { get } from 'svelte/store'
import { describe, expect, test } from 'vitest'
import { answerChoice, cancelChoice, choiceInteractionStore, requestChoice } from './choice'
import { requestDiceRoll } from './dice'
import { resetToolInteractionForTests } from './interaction'

describe('inline choice interaction', () => {
    test('returns the selected structured option', async () => {
        resetToolInteractionForTests()
        const pending = requestChoice({
            question: 'Pick a door',
            options: [{ label: 'Red', value: 'door-red', description: 'Warm' }, 'Blue'],
        })
        const interaction = get(choiceInteractionStore)
        expect(interaction?.request.options[0]).toEqual({ label: 'Red', value: 'door-red', description: 'Warm' })
        answerChoice(interaction!.id, 0)
        await expect(pending).resolves.toEqual({ status: 'answered', index: 0, label: 'Red', value: 'door-red' })
    })

    test('resolves cancellation without throwing', async () => {
        resetToolInteractionForTests()
        const pending = requestChoice({ question: 'Continue?', options: ['Yes', 'No'] })
        cancelChoice(get(choiceInteractionStore)!.id)
        await expect(pending).resolves.toEqual({ status: 'cancelled' })
    })

    test('validates options and shares the interactive lock with dice', async () => {
        resetToolInteractionForTests()
        expect(() => requestChoice({ question: 'Empty', options: [] })).toThrow('1 to 20')
        const pending = requestChoice({ question: 'Choose', options: ['A'] })
        await expect(requestDiceRoll({ kind: 'd6' })).rejects.toThrow('Another interactive tool')
        cancelChoice(get(choiceInteractionStore)!.id)
        await pending
    })
})
