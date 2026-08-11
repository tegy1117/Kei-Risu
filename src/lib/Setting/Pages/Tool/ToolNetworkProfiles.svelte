<script lang="ts">
    import { PlusIcon, TrashIcon } from '@lucide/svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { notifyError, notifySuccess } from 'src/ts/alert'
    import { safeStructuredClone } from 'src/ts/polyfill'
    import type { ToolHttpMethod, ToolNetworkProfile, ToolNetworkSettings } from 'src/ts/process/tools/types'
    import { DBState } from 'src/ts/stores.svelte'
    import { v4 } from 'uuid'

    let { onclose }: { onclose: () => void } = $props()
    let draft = $state<ToolNetworkSettings>(safeStructuredClone(DBState.db.toolNetworkSettings ?? { profiles: [], approvedOrigins: {} }))

    function addProfile(kind: ToolNetworkProfile['kind']) {
        draft.profiles.push({
            id: v4(), kind, name: kind === 'http' ? 'HTTP API' : 'Web Search', description: '',
            baseUrl: kind === 'http' ? 'https://api.example.com/' : undefined,
            urlTemplate: kind === 'search' ? 'https://search.example.com/?q={{query}}&count={{count}}&offset={{offset}}' : undefined,
            method: 'GET', headers: {}, secrets: {}, timeoutMs: 30_000, maxResponseBytes: 262_144,
            mapping: kind === 'search' ? { itemsPath: 'results', titlePath: 'title', urlPath: 'url', snippetPath: 'snippet' } : undefined,
        })
        draft.profiles = [...draft.profiles]
    }

    function renameRecordKey(record: Record<string, string>, oldKey: string, nextKey: string) {
        if (!nextKey || nextKey === oldKey || nextKey in record) return
        const entries = Object.entries(record).map(([key, value]) => key === oldKey ? [nextKey, value] : [key, value])
        for (const key of Object.keys(record)) delete record[key]
        Object.assign(record, Object.fromEntries(entries))
    }

    function addRecordEntry(record: Record<string, string>, prefix: string) {
        let index = 1
        let key = prefix
        while (key in record) key = `${prefix}${++index}`
        record[key] = ''
    }

    function validate() {
        const names = new Set<string>()
        for (const profile of draft.profiles) {
            profile.name = profile.name.trim()
            if (!profile.name) throw new Error('모든 네트워크 프로필에는 이름이 필요합니다.')
            const scopedName = `${profile.kind}:${profile.name.toLowerCase()}`
            if (names.has(scopedName)) throw new Error(`Duplicate ${profile.kind} profile name: ${profile.name}`)
            names.add(scopedName)
            const value = profile.kind === 'http' ? profile.baseUrl : profile.urlTemplate
            if (!value) throw new Error(`${profile.name} needs a URL.`)
            const probe = value.replaceAll('{{query}}', 'query').replaceAll('{{count}}', '10').replaceAll('{{offset}}', '0').replace(/\{\{secret:[^}]+\}\}/g, 'secret')
            const url = new URL(probe)
            if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${profile.name} must use HTTP(S).`)
            if (profile.kind === 'search' && !value.includes('{{query}}')) throw new Error(`${profile.name} must include {{query}}.`)
            profile.timeoutMs = Math.max(1000, Math.min(120_000, Math.floor(Number(profile.timeoutMs) || 30_000)))
            profile.maxResponseBytes = Math.max(1024, Math.min(1_048_576, Math.floor(Number(profile.maxResponseBytes) || 262_144)))
        }
    }

    function save() {
        try {
            validate()
            DBState.db.toolNetworkSettings = safeStructuredClone(draft)
            notifySuccess('네트워크 툴 프로필을 저장했습니다.')
            onclose()
        } catch (error) {
            notifyError(error)
        }
    }
</script>

<div class="flex flex-col gap-4">
    <p class="text-sm text-textcolor2">프로필의 API 인증정보는 모델에 보이는 툴 인자와 분리됩니다. 비밀값 치환에는 <code>{'{{secret:name}}'}</code> 형식을 사용합니다.</p>
    <div class="flex gap-2">
        <ShButton variant="outline" onclick={() => addProfile('http')}><PlusIcon size={16}/> HTTP 프로필 추가</ShButton>
        <ShButton variant="outline" onclick={() => addProfile('search')}><PlusIcon size={16}/> 검색 프로필 추가</ShButton>
    </div>

    {#each draft.profiles as profile, profileIndex}
        <section class="border border-darkborderc rounded-md p-3 flex flex-col gap-3">
            <div class="flex gap-2 items-center">
                <strong>{profile.kind === 'http' ? 'HTTP' : 'Web Search'}</strong>
                <button class="ml-auto text-textcolor2 hover:text-red-400" onclick={() => { draft.profiles.splice(profileIndex, 1); draft.profiles = [...draft.profiles] }}><TrashIcon size={18}/></button>
            </div>
            <TextInput bind:value={profile.name} placeholder="Profile name" />
            <TextInput bind:value={profile.description} placeholder="Description shown to the model" />
            {#if profile.kind === 'http'}
                <TextInput bind:value={profile.baseUrl} placeholder="https://api.example.com/" />
            {:else}
                <TextInput bind:value={profile.urlTemplate} placeholder={'https://search.example.com/?q={{query}}'} />
                <textarea class="bg-transparent border border-darkborderc rounded-md p-2 min-h-20 font-mono" bind:value={profile.bodyTemplate} placeholder="Optional request body template"></textarea>
            {/if}
            <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
                <select class="bg-darkbg border border-darkborderc rounded-md p-2" bind:value={profile.method}>
                    {#each ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as method}<option value={method}>{method}</option>{/each}
                </select>
                <label class="text-sm">Timeout ms<input class="block w-full bg-transparent border border-darkborderc rounded-md p-2" type="number" bind:value={profile.timeoutMs}/></label>
                <label class="text-sm">Max response bytes<input class="block w-full bg-transparent border border-darkborderc rounded-md p-2" type="number" bind:value={profile.maxResponseBytes}/></label>
            </div>
            <strong class="text-sm">Headers</strong>
            {#each Object.entries(profile.headers) as [key, value]}
                <div class="flex gap-2">
                    <input class="grow bg-transparent border border-darkborderc rounded-md p-2" value={key} onchange={(event) => renameRecordKey(profile.headers, key, event.currentTarget.value.trim())}/>
                    <input class="grow bg-transparent border border-darkborderc rounded-md p-2" bind:value={profile.headers[key]} placeholder="Value or {{secret:name}}"/>
                    <button class="text-textcolor2 hover:text-red-400" onclick={() => { delete profile.headers[key]; profile.headers = { ...profile.headers } }}><TrashIcon size={16}/></button>
                </div>
            {/each}
            <button class="text-sm text-textcolor2 hover:text-primary self-start" onclick={() => { addRecordEntry(profile.headers, 'Header'); profile.headers = { ...profile.headers } }}>+ Header</button>
            <strong class="text-sm">Secrets</strong>
            {#each Object.entries(profile.secrets) as [key, value]}
                <div class="flex gap-2">
                    <input class="grow bg-transparent border border-darkborderc rounded-md p-2" value={key} onchange={(event) => renameRecordKey(profile.secrets, key, event.currentTarget.value.trim())}/>
                    <TextInput className="grow" hideText={true} bind:value={profile.secrets[key]} placeholder="Secret value" />
                    <button class="text-textcolor2 hover:text-red-400" onclick={() => { delete profile.secrets[key]; profile.secrets = { ...profile.secrets } }}><TrashIcon size={16}/></button>
                </div>
            {/each}
            <button class="text-sm text-textcolor2 hover:text-primary self-start" onclick={() => { addRecordEntry(profile.secrets, 'apiKey'); profile.secrets = { ...profile.secrets } }}>+ Secret</button>
            {#if profile.kind === 'search' && profile.mapping}
                <strong class="text-sm">JSON result paths</strong>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <TextInput bind:value={profile.mapping.itemsPath} placeholder="results" />
                    <TextInput bind:value={profile.mapping.titlePath} placeholder="title" />
                    <TextInput bind:value={profile.mapping.urlPath} placeholder="url" />
                    <TextInput bind:value={profile.mapping.snippetPath} placeholder="snippet" />
                </div>
            {/if}
        </section>
    {/each}

    <section class="border border-darkborderc rounded-md p-3">
        <strong>승인된 Origin</strong>
        {#each Object.entries(draft.approvedOrigins).filter(([, approved]) => approved) as [origin]}
            <div class="flex items-center gap-2 mt-2"><code class="grow">{origin}</code><button class="text-textcolor2 hover:text-red-400" onclick={() => { delete draft.approvedOrigins[origin]; draft.approvedOrigins = { ...draft.approvedOrigins } }}><TrashIcon size={16}/></button></div>
        {/each}
    </section>
    <div class="flex gap-2">
        <ShButton variant="outline" onclick={onclose}>취소</ShButton>
        <ShButton onclick={save}>저장</ShButton>
    </div>
</div>
