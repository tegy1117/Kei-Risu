import { describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'
import { activateDiceRoll, diceInteractionStore, requestDiceRoll, rollDice } from './dice'

function sequence(values: number[]) {
    const mock = vi.fn(() => {
        const value = values.shift()
        if (value === undefined) throw new Error('Random sequence exhausted')
        return value
    })
    return mock
}

describe('TRPG dice', () => {
    test('supports coin labels and applies one modifier after bundled rolls', () => {
        const random = sequence([1, 2])
        const result = rollDice({ kind: 'coin', count: 2, modifier: 3 }, random)
        expect(result.rolls).toEqual([{ value: 1, label: 'Heads' }, { value: 2, label: 'Tails' }])
        expect(result.rawTotal).toBe(3)
        expect(result.total).toBe(6)
        expect(random).toHaveBeenNthCalledWith(1, 1, 2)
    })

    test('treats d100 00 as 100 and preserves both percentile dice', () => {
        expect(rollDice({ kind: 'd100' }, sequence([0, 0])).rolls[0]).toEqual({ value: 100, dice: [0, 0] })
        expect(rollDice({ kind: 'd100' }, sequence([7, 3])).rolls[0]).toEqual({ value: 73, dice: [7, 3] })
    })

    test('rolls every standard die with inclusive bounds', () => {
        for (const [kind, sides] of [['d4', 4], ['d6', 6], ['d10', 10], ['d20', 20]] as const) {
            const random = sequence([sides])
            expect(rollDice({ kind }, random).total).toBe(sides)
            expect(random).toHaveBeenCalledWith(1, sides)
        }
    })

    test('uses one arbitrary inclusive integer range as roulette', () => {
        const random = sequence([-7])
        const result = rollDice({ kind: 'range', min: -10, max: 10, count: 9, modifier: 2 }, random)
        expect(result.count).toBe(1)
        expect(result.rolls[0].value).toBe(-7)
        expect(result.total).toBe(-5)
        expect(random).toHaveBeenCalledWith(-10, 10)
    })

    test('rejects invalid counts, ranges, and modifiers', () => {
        expect(() => rollDice({ kind: 'd6', count: 0 }, sequence([]))).toThrow('1 to 100')
        expect(() => rollDice({ kind: 'range', min: 2, max: 1 }, sequence([]))).toThrow('min <= max')
        expect(() => rollDice({ kind: 'd20', modifier: 1.5 }, sequence([]))).toThrow('safe integer')
    })

    test('does not choose a random value until the user activates the roll', async () => {
        vi.useFakeTimers()
        const randomSpy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
            const words = array as Uint32Array
            words[0] = 0
            words[1] = 5
            return array
        })
        try {
            const pending = requestDiceRoll({ kind: 'd20' })
            expect(randomSpy).not.toHaveBeenCalled()
            const interaction = get(diceInteractionStore)
            expect(interaction?.status).toBe('waiting')
            activateDiceRoll(interaction!.id, 0)
            expect(randomSpy).toHaveBeenCalledTimes(1)
            await vi.runAllTimersAsync()
            expect((await pending).total).toBe(6)
        } finally {
            randomSpy.mockRestore()
            vi.useRealTimers()
        }
    })
})
