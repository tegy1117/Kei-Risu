import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPastedImageFiles, readClipboardImageFiles } from './clipboardImages'

function transfer(files: File[], itemTypes = files.map(file => file.type)): DataTransfer {
    return {
        items: files.map((file, index) => ({kind: 'file', type: itemTypes[index], getAsFile: () => file})),
        files,
    } as unknown as DataTransfer
}

afterEach(() => vi.unstubAllGlobals())

describe('Android clipboard file handling', () => {
    it('accepts a file whose item MIME is missing but file MIME is an image', () => {
        const file = new File(['image'], 'content', {type:'image/jpeg'})
        const images = getPastedImageFiles(transfer([file], ['']))
        expect(images).toHaveLength(1)
        expect(images[0].name).toBe('clipboard.jpg')
        expect(images[0].size).toBe(file.size)
    })

    it('uses the item MIME when the file MIME and filename are missing', () => {
        const images = getPastedImageFiles(transfer([new File(['image'], '')], ['image/png']))
        expect(images[0].name).toBe('clipboard.png')
        expect(images[0].type).toBe('image/png')
    })

    it('uses files when the browser supplies no usable items, without duplicating both representations', () => {
        const file = new File(['image'], 'IMAGE.PNG')
        expect(getPastedImageFiles({items: [], files: [file]} as unknown as DataTransfer)).toHaveLength(1)
        expect(getPastedImageFiles(transfer([file]))).toHaveLength(1)
    })

    it('ignores text, HTML and missing clipboard data', () => {
        expect(getPastedImageFiles(transfer([new File(['text'], 'image.png', {type:'text/html'})]))).toEqual([])
        expect(getPastedImageFiles({items: [{kind:'string',type:'text/plain'}],files:[]} as unknown as DataTransfer)).toEqual([])
        expect(getPastedImageFiles(null)).toEqual([])
    })
})

describe('explicit clipboard image reading without a paste event', () => {
    it('starts reading immediately in the user gesture and selects only one image representation per item', async () => {
        const getType = vi.fn(async (type: string) => new Blob(['image'], {type}))
        const read = vi.fn(async () => [{types:['text/html','image/png','image/jpeg'],getType}])
        vi.stubGlobal('navigator', {clipboard:{read}})
        const pending = readClipboardImageFiles()
        expect(read).toHaveBeenCalledOnce()
        const images = await pending
        expect(images).toHaveLength(1)
        expect(images[0].name).toBe('clipboard.png')
        expect(getType).toHaveBeenCalledExactlyOnceWith('image/png')
    })

    it('does not request clipboard text content', async () => {
        const getType = vi.fn()
        vi.stubGlobal('navigator', {clipboard:{read:async () => [{types:['text/plain'],getType}]}})
        expect(await readClipboardImageFiles()).toEqual([])
        expect(getType).not.toHaveBeenCalled()
    })

    it('propagates denied clipboard access so the UI can show a retry/upload option', async () => {
        vi.stubGlobal('navigator', {clipboard:{read:async () => {throw new DOMException('Denied','NotAllowedError')}}})
        await expect(readClipboardImageFiles()).rejects.toMatchObject({name:'NotAllowedError'})
    })

    it('handles browsers without the asynchronous clipboard API', async () => {
        vi.stubGlobal('navigator', {})
        await expect(readClipboardImageFiles()).rejects.toThrow('unavailable')
    })
})
