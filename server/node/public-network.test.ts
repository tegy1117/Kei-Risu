import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import pkg from './public-network.cjs'

const {
    isPublicAddress,
    requestPinnedPublicUrl,
    resolvePublicNetworkUrl,
} = pkg as {
    isPublicAddress: (address: string) => boolean
    requestPinnedPublicUrl: (target: any, init: any, clients: any) => Promise<Response>
    resolvePublicNetworkUrl: (value: string, lookup?: (...args: any[]) => Promise<any[]>) => Promise<any>
}

describe('public network policy', () => {
    it.each([
        '127.0.0.1',
        '10.0.0.1',
        '169.254.169.254',
        '::1',
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        '64:ff9b::7f00:1',
        '2002:7f00:1::',
        '2001:0000:4136:e378:8000:63bf:3fff:fdd2',
    ])('rejects private, reserved, and transition address %s', (address) => {
        expect(isPublicAddress(address)).toBe(false)
    })

    it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
        'accepts public unicast address %s',
        (address) => expect(isPublicAddress(address)).toBe(true),
    )

    it('rejects a hostname if any DNS answer is not public', async () => {
        const lookup = vi.fn(async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 },
        ])
        await expect(resolvePublicNetworkUrl('https://example.com/path', lookup)).rejects.toThrow(
            'Public network policy blocked host example.com',
        )
    })

    it('normalizes a public IPv4-mapped DNS answer and corrects its family', async () => {
        const lookup = vi.fn(async () => [{ address: '::ffff:8.8.8.8', family: 6 }])
        await expect(resolvePublicNetworkUrl('https://example.com', lookup)).resolves.toMatchObject({
            address: '8.8.8.8',
            family: 4,
        })
    })

    it('pins the normalized DNS answer into the socket request', async () => {
        const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
        const target = await resolvePublicNetworkUrl('https://example.com:8443/path?q=1', lookup)
        let capturedOptions: any
        const writes: unknown[] = []
        const request = vi.fn((options: any, callback: (incoming: any) => void) => {
            capturedOptions = options
            const outgoing = new EventEmitter() as any
            outgoing.write = (value: unknown) => writes.push(value)
            outgoing.end = () => {
                const incoming = Readable.from([Buffer.from('ok')]) as any
                incoming.statusCode = 200
                incoming.statusMessage = 'OK'
                incoming.rawHeaders = ['content-type', 'text/plain']
                callback(incoming)
            }
            return outgoing
        })

        const response = await requestPinnedPublicUrl(target, {
            method: 'POST',
            headers: { 'x-test': 'yes', Host: 'attacker.invalid' },
            body: 'payload',
        }, { http: { request }, https: { request } })

        expect(capturedOptions).toMatchObject({
            protocol: 'https:',
            hostname: '93.184.216.34',
            family: 4,
            port: '8443',
            path: '/path?q=1',
            servername: 'example.com',
            headers: { 'x-test': 'yes', host: 'example.com:8443' },
        })
        expect(writes).toEqual(['payload'])
        expect(await response.text()).toBe('ok')
    })

    it('rejects unsupported schemes and embedded credentials before lookup', async () => {
        const lookup = vi.fn()
        await expect(resolvePublicNetworkUrl('file:///etc/passwd', lookup)).rejects.toThrow('Only HTTP(S)')
        await expect(resolvePublicNetworkUrl('https://user:pass@example.com', lookup)).rejects.toThrow('Credentials')
        expect(lookup).not.toHaveBeenCalled()
    })
})
