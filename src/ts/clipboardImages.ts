const imageExtensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
}

function normalizeImage(file: File, itemType = ''): File | null {
    const type = (file.type || itemType).toLowerCase()
    const extension = file.name.split('.').at(-1)?.toLowerCase()
    const namedImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(extension ?? '')
    if (!type.startsWith('image/') && !((!type || type === 'application/octet-stream') && namedImage)) return null
    // Android clipboard files can have no filename/extension. postChatFile uses
    // the extension to select the image path, so derive it from the MIME type.
    const imageExtension = imageExtensions[type] || (namedImage ? extension : 'png')
    return new File([file], `clipboard.${imageExtension}`, { type: type || `image/${imageExtension}` })
}

export function getPastedImageFiles(data: DataTransfer | null): File[] {
    if (!data) return []
    const files: File[] = []
    for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        const image = file && normalizeImage(file, item.type)
        if (image) files.push(image)
    }
    if (files.length > 0) return files
    return Array.from(data.files ?? []).map(file => normalizeImage(file)).filter((file): file is File => file !== null)
}

export async function readClipboardImageFiles(): Promise<File[]> {
    if (!navigator.clipboard?.read) throw new Error('Clipboard image reading is unavailable')
    // Call read immediately in the click handler's user activation, before any
    // dialog or timer. A browser may show its own clipboard permission prompt.
    const items = await navigator.clipboard.read()
    const files: File[] = []
    for (const item of items) {
        // Multiple formats on one ClipboardItem represent the same image.
        const type = item.types.find(type => type.startsWith('image/'))
        if (!type) continue
        const blob = await item.getType(type)
        const image = normalizeImage(new File([blob], '', { type }))
        if (image) files.push(image)
    }
    return files
}
