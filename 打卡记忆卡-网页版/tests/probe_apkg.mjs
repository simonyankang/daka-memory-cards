// 预检探针：用真实下载的 JSZip + sql.js 跑通 .apkg 解析链路。
// 只验证「能不能解、能不能读、能不能取字段」，不含业务逻辑。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dir = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dir, '..')

const JSZip = require(path.join(ROOT, 'vendor', 'jszip.min.js'))
const initSqlJs = require(path.join(ROOT, 'vendor', 'sql-wasm.js'))
const wasmBinary = fs.readFileSync(path.join(ROOT, 'vendor', 'sql-wasm.wasm'))

async function main() {
  const SQL = await initSqlJs({ wasmBinary })
  console.log('[ok] sql.js wasm 初始化成功')

  const cases = [
    ['fixture.apkg', 'collection.anki2', 13],
    ['fixture_anki21.apkg', 'collection.anki21', 13],
    ['fixture_anki21b.apkg', 'collection.anki21b', -1],
    ['fixture_bad.apkg', null, 0],
  ]

  for (const [file, expectEntry, expectNotes] of cases) {
    const buf = fs.readFileSync(path.join(__dir, file))
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files)
    console.log(`\n[case] ${file} -> entries: ${JSON.stringify(names)}`)

    const dbEntry =
      zip.file('collection.anki2') ||
      zip.file('collection.anki21') ||
      zip.file('collection.anki21b')

    if (!dbEntry) {
      console.log('  [ok] 未发现数据库条目，将走「非 apkg / 无数据库」提示')
      continue
    }

    if (dbEntry.name === 'collection.anki21b') {
      const head = await dbEntry.async('nodebuffer')
      const isZstd = head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd
      console.log(`  [ok] 识别为 anki21b，Zstd 魔数=${isZstd} -> 应走友好降级，不伪称可读`)
      continue
    }

    const bin = await dbEntry.async('nodebuffer')
    const db = new SQL.Database(bin)
    const res = db.exec('SELECT guid, flds, tags FROM notes')
    if (!res.length) {
      console.log('  [FAIL] 查询无结果')
      process.exitCode = 1
      continue
    }
    const cols = res[0].columns
    const rows = res[0].values
    console.log(`  [ok] ${dbEntry.name} 读取 notes ${rows.length} 行 (期望 ${expectNotes})`)
    const first = Object.fromEntries(cols.map((c, i) => [c, rows[0][i]]))
    console.log(`  [ok] 首行 flds=${JSON.stringify(first.flds)} tags=${JSON.stringify(first.tags)}`)

    const imgRow = rows.find((r) => String(r[1]).includes('<img'))
    const sndRow = rows.find((r) => String(r[1]).includes('sound:'))
    console.log(`  [ok] 媒体引用行存在: img=${!!imgRow} sound=${!!sndRow}`)

    const dupGuid = rows.filter((r) => r[0] === 'g9').length
    console.log(`  [ok] 重复 guid=g9 出现 ${dupGuid} 次 -> 去重逻辑应合并为 1`)
    db.close()

    if (rows.length !== expectNotes) {
      console.log(`  [FAIL] 行数不符`)
      process.exitCode = 1
    }
  }
  console.log('\n[done] 预检结束，exitCode=' + (process.exitCode || 0))
}

main().catch((e) => {
  console.error('[FATAL]', e)
  process.exitCode = 1
})
