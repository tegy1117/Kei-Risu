import { lazyFunction, getExecutionContext, bindExecutionContext, type ChatExecutionContext } from '../executionScope'
import { getDatabase as getDatabaseUnscoped, type Chat, type character } from "src/ts/storage/database.svelte";
import { HypaProcesser } from '../memory/hypamemory'
import { getUserName as getUserNameUnscoped } from "src/ts/util";
const getDatabase = lazyFunction(() => getDatabaseUnscoped)
const getUserName = lazyFunction(() => getUserNameUnscoped)


export async function additionalInformations(char: character,chats:Chat,){
    const executionContext = getExecutionContext()
    const getDatabase = bindExecutionContext(executionContext, () => getDatabaseUnscoped, true)
    const getUserName = bindExecutionContext(executionContext, () => getUserNameUnscoped, true)

    const processer = new HypaProcesser()
    const db = getDatabase()

    const info = char.additionalText
    if(info){
        const infos = info.split('\n\n')

        await processer.addText(infos)
        const filteredChat = chats.message.slice(0, 4).map((chat) => {
            let name = chat.saying ?? ''

            if(!name){
                if(chat.role === 'user'){
                    name = getUserName()
                }
                else{
                    name = char.name
                }
            }

            return `${name}: ${chat.data}`
        }).join("\n\n")
        const searched = await processer.similaritySearch(filteredChat)
        const result = searched.slice(0,3).join("\n\n")
        return result
    }

    return ''

}