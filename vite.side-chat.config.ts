import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
    plugins: [{
        name: 'side-chat-server-oauth',
        enforce: 'pre',
        resolveId(id, importer) {
            if (id === './token' && importer?.replaceAll('\\', '/').endsWith('/adapter/googleServiceAccount/cache.ts')) return resolve('src/ts/sideChat/serverToken.ts')
        },
    }],
    ssr: { noExternal: true },
    build: {
        ssr: 'src/ts/sideChat/serverRuntime.ts', outDir: 'dist', emptyOutDir: false,
        minify: false, rolldownOptions: { output: { format: 'cjs', entryFileNames: 'side-chat-runtime.cjs' } },
    },
})
