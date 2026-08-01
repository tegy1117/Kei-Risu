import { describe, expect, it, vi } from 'vitest'
import pkg from './update-extractor.cjs'

const { extractUpdateArchive } = pkg as {
    extractUpdateArchive: (
        archivePath: string,
        extractDir: string,
        options: { platform: string; execFileSync: (...args: any[]) => void },
    ) => void
}

describe('extractUpdateArchive', () => {
    it('passes Unix paths as tar arguments without shell interpolation', () => {
        const run = vi.fn()
        const archivePath = '/tmp/update;touch PWNED.tar.gz'
        const extractDir = '/tmp/output $(touch PWNED)'

        extractUpdateArchive(archivePath, extractDir, { platform: 'linux', execFileSync: run })

        expect(run).toHaveBeenCalledWith(
            'tar',
            ['-xzf', archivePath, '-C', extractDir],
            { timeout: 300000 },
        )
    })

    it('passes Windows paths as tar arguments when built-in tar succeeds', () => {
        const run = vi.fn()
        const archivePath = String.raw`C:\Temp\update & whoami.zip`
        const extractDir = String.raw`C:\Temp\output folder`

        extractUpdateArchive(archivePath, extractDir, { platform: 'win32', execFileSync: run })

        expect(run).toHaveBeenCalledWith(
            'tar',
            ['-xf', archivePath, '-C', extractDir],
            { timeout: 300000 },
        )
    })

    it('keeps untrusted Windows paths out of the PowerShell command', () => {
        const run = vi.fn()
            .mockImplementationOnce(() => { throw new Error('tar unavailable') })
            .mockImplementationOnce(() => undefined)
        const archivePath = String.raw`C:\Temp\update'; whoami; '.zip`
        const extractDir = String.raw`C:\Temp\output & whoami`

        extractUpdateArchive(archivePath, extractDir, { platform: 'win32', execFileSync: run })

        const [, powershellArgs, powershellOptions] = run.mock.calls[1]
        expect(run.mock.calls[1][0]).toBe('powershell')
        expect(powershellArgs.join(' ')).not.toContain(archivePath)
        expect(powershellArgs.join(' ')).not.toContain(extractDir)
        expect(powershellOptions.env.RISU_UPDATE_ARCHIVE).toBe(archivePath)
        expect(powershellOptions.env.RISU_UPDATE_EXTRACT_DIR).toBe(extractDir)
    })
})
