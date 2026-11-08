import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { startServer } from './server.js'

const args = process.argv.slice(2)
let dataDir = process.env.DSH_DOCS_DATA_DIR ?? join(homedir(), '.dsh', 'collaborative-docs')
let port = 0
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (flag === '--data-dir' && args[index + 1]) dataDir = resolve(args[++index])
  else if (flag === '--port' && args[index + 1]) {
    port = Number(args[++index])
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535')
  } else throw new Error(`Unknown or incomplete option: ${flag}`)
}
const server = await startServer({ dataDir, port })
// Intentional explicit standalone output: this URL is the owner's bootstrap capability.
console.log(`Open local documents: ${server.url}`)
let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  void server.close().catch(error => { console.error(error); process.exitCode = 1 })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
