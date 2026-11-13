// 端到端自检：core.js 回归 + apkg.js 四种样本解析。
// 用真实下载的 vendor 依赖 + Python 造的 .apkg 样本，Node v22 跑。
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
const C = require(path.join(ROOT, 'core.js'))
const { parseApkg } = require(path.join(ROOT, 'apkg.js'))

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label) }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')) }
}
function section(t) { console.log('\n== ' + t + ' ==') }

async function main() {
  const deps = { JSZip, initSqlJs, DakaCore: C, sqlJsConfig: { wasmBinary } }

  section('core.js 回归：CSV 导入行为不变')
  {
    const st = C.initState('2026-01-01')
    const csv = 'front,back,tags,guid\nQ1,A1,t1,g1\nQ2,A2,t2,g2'
    const r = C.importCards(st, csv, '2026-01-01')
    ok(r.ok && r.inserted === 2, 'CSV 导入 2 张', r)
    ok(Object.keys(st.reviews).length === 2, '生成 2 条 review')
    const r2 = C.importCards(st, csv, '2026-01-01')
    ok(r2.ok && r2.inserted === 0 && r2.dupInDb === 2, '重导入不新增、不覆盖进度', r2)
  }

  section('core.js 新函数：stripMarkup / hasCloze')
  {
    const a = C.stripMarkup('<b>水的</b>化学式是？<br>H<sub>2</sub>O')
    ok(a.text === '水的化学式是？\nH2O', 'HTML 标签剥离 + br 换行 + 保留下标文字', a)
    const b = C.stripMarkup('看图 <img src="0.jpg"> 这是什么？')
    ok(b.text === '看图  这是什么？' && b.mediaRefs.length === 1, 'img 引用剥离并计数', b)
    const c = C.stripMarkup('拼写 [sound:_1.mp3] hello')
    ok(c.text === '拼写  hello' && c.mediaRefs.length === 1, 'Anki [sound:] 音频引用剥离并计数', c)
    const d = C.stripMarkup('A&nbsp;&amp;B &lt;x&gt; &#65;')
    ok(d.text === 'A &B <x> A', 'HTML 实体还原', d)
    ok(C.hasCloze('{{c1::北京}}是首都') === true, '识别 Cloze')
    ok(C.hasCloze('普通文本') === false, '普通文本不误判为 Cloze')
  }

  section('core.js importRows：去重口径与 CSV 一致')
  {
    const st = C.initState('2026-01-01')
    const rows = [
      { front: 'Q1', back: 'A1', tags: [], ankiGuid: 'a:g1' },
      { front: 'Q1dup', back: 'A1', tags: [], ankiGuid: 'a:g1' },
      { front: 'Q2', back: 'A2', tags: [], ankiGuid: 'a:g2' }
    ]
    const r = C.importRows(st, rows, '2026-01-01')
    ok(r.ok && r.inserted === 2 && r.dupInFile === 1, '文件内重复 guid 合并为 1', r)
  }

  section('apkg.js：老版 collection.anki2')
  {
    const buf = fs.readFileSync(path.join(__dir, 'fixture.apkg'))
    const r = await parseApkg(buf, deps)
    ok(r.ok, '解析成功', r.errors)
    ok(r.meta.dbEntry === 'collection.anki2', '命中正确数据库条目', r.meta.dbEntry)
    ok(r.meta.noteCount === 14, 'notes 共 14 行', r.meta.noteCount)
    ok(r.meta.skippedCloze === 1, '跳过 1 张 Cloze', r.meta.skippedCloze)
    ok(r.meta.skippedEmpty === 1, '跳过 1 张正反面全空', r.meta.skippedEmpty)
    ok(r.meta.mediaRefs === 2, '剥离 2 处媒体引用（img + [sound:] 各 1）', r.meta.mediaRefs)
    // 14 - 1(cloze) - 1(empty) = 12 行产出
    ok(r.rows.length === 12, '产出 12 行待入库', r.rows.length)
    const g1 = r.rows.find((x) => x.ankiGuid === 'a:g1')
    ok(g1 && g1.front === '中国的首都是哪座城市？' && g1.back === '北京', '首字段=正面 其余=背面', g1)
    const g3 = r.rows.find((x) => x.ankiGuid === 'a:g3')
    ok(g3 && g3.front === '水的化学式是？', 'HTML 标签已清洗', g3)
    const g7 = r.rows.find((x) => x.ankiGuid === 'a:g7')
    ok(g7 && g7.front === '前后有空格的问题' && g7.back === '答案', '前后空白已 trim', g7)
    const g8 = r.rows.find((x) => x.ankiGuid === 'a:g8')
    ok(g8 && g8.front.includes('逗号') && g8.front.includes('\n') && g8.back.includes('\n'), '逗号/引号/换行字段完整保留', g8)
    const g9 = r.rows.filter((x) => x.ankiGuid === 'a:g9')
    ok(g9.length === 2, 'apkg 层保留重复 guid（去重交给 importRows 统一处理）', g9.length)
    const g11 = r.rows.find((x) => x.ankiGuid === 'a:g11')
    ok(g11 && g11.front === '只有背面没有正面' && g11.back === '', '只有背面时兜底为正面，不丢卡', g11)
    const g5 = r.rows.find((x) => x.ankiGuid === 'a:g5')
    ok(g5 && g5.front === '听发音并拼写' && g5.back === 'hello' && !g5.front.includes('sound:'), '[sound:] 引用已剥离，答案落在背面', g5)
    const noGuid = r.rows.find((x) => x.front === '没有guid的卡片')
    ok(noGuid && /^h:/.test(noGuid.ankiGuid), '无 guid 卡片走正文哈希', noGuid)
  }

  section('apkg.js：新版 collection.anki21（未压缩 SQLite）')
  {
    const buf = fs.readFileSync(path.join(__dir, 'fixture_anki21.apkg'))
    const r = await parseApkg(buf, deps)
    ok(r.ok && r.meta.dbEntry === 'collection.anki21' && r.rows.length === 12, 'anki21 同样可读', { ok: r.ok, entry: r.meta.dbEntry, rows: r.rows.length })
  }

  section('apkg.js：.colpkg 整库包（同名数据库条目）')
  {
    const cp = path.join(__dir, 'fixture.colpkg')
    if (fs.existsSync(cp)) {
      const r = await parseApkg(fs.readFileSync(cp), deps)
      ok(r.ok && r.rows.length === 12 && r.meta.dbEntry === 'collection.anki2', '.colpkg 同构包可读', { ok: r.ok, rows: r.rows.length, entry: r.meta.dbEntry })
    } else {
      ok(false, '.colpkg 样本缺失（应先跑 make_apkg_fixture.py 生成全部样本）')
    }
  }

  section('apkg.js：anki21b（Zstd）友好降级')
  {
    const buf = fs.readFileSync(path.join(__dir, 'fixture_anki21b.apkg'))
    const r = await parseApkg(buf, deps)
    ok(!r.ok && r.errors[0].includes('Zstd') && r.errors[0].includes('CSV'), '明确提示换兼容格式/CSV，不伪称可读', r.errors)
  }

  section('apkg.js：坏包 / 非 apkg')
  {
    const buf = fs.readFileSync(path.join(__dir, 'fixture_bad.apkg'))
    const r = await parseApkg(buf, deps)
    ok(!r.ok && r.errors[0].includes('找不到'), '无数据库条目时给出清晰错误', r.errors)
    const r2 = await parseApkg(Buffer.from('not a zip at all'), deps)
    ok(!r2.ok && r2.errors[0].includes('ZIP 解包失败'), '非 ZIP 文件报错', r2.errors)
  }

  section('端到端：apkg -> importRows 全链路')
  {
    const buf = fs.readFileSync(path.join(__dir, 'fixture.apkg'))
    const r = await parseApkg(buf, deps)
    const st = C.initState('2026-01-01')
    const ir = C.importRows(st, r.rows, '2026-01-01')
    // 12 行里 g9 重复 1 次 -> 去重后 11 张入库
    ok(ir.ok && ir.inserted === 11 && ir.dupInFile === 1, '端到端入库 11 张（12 行去重 1）', ir)
    ok(st.cards.length === 11 && Object.keys(st.reviews).length === 11, '卡片与排程数量一致', { cards: st.cards.length, reviews: Object.keys(st.reviews).length })
  }

  console.log('\n==== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ====')
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1 })
