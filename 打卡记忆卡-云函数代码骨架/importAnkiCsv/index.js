// importAnkiCsv —— 一期「纯文字 CSV」批量导入记忆卡片（零第三方依赖）
//
// 为什么是一期 CSV 而不是直接读 .apkg：
//   .apkg = ZIP + collection.anki2(SQLite) + media JSON；小程序端解不了 ZIP/SQLite，
//   云函数端读 SQLite 需引三方库且新版 anki21b 带 Zstd 压缩，兼容坑多。
//   纯文字场景让用户从 Anki 导出为 CSV 再粘贴/上传，一期零依赖、最稳。.apkg 解析放二期。
//
// 依据（官方一手/社区核实，采集 2026-11-12）：
//   - cloud.init / getWXContext().OPENID：微信开放文档「我的第一个云函数」「初始化」
//   - 云函数端 add 不会自动注入 _openid，必须显式写：微信开放社区官方精选帖
//     「云开发能力基础讲解」「使用云函数向云数据库插入记录需要手动添加openid么」
//   - add 只支持单条：官方「插入数据」页；故批量靠受控并发 Promise.all，非一条 add 数组
//   - 云函数 API 超时默认 15s：官方「云函数端初始化」页 timeout 字段说明
//   - 云函数身份继承调用方 OPENID 的争议：docs.cloudbase.net「在小程序中调用 CloudBase 云函数」
//     与社区通行「管理端绕过」说法冲突 → 本函数不赌，强制用 getWXContext().OPENID 过滤
// [假设] 项：CSV 转义规则、去重键、批次大小、行数上限 —— 均在常量处标注，可按实测调整。

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// [假设] 官方未写明 _.in 元素上限，取 20 保守分批查重；可按压测调大。
const IN_BATCH = 20
// [假设] 官方未写明单次 add 并发上限；取 20 受控并发，兼顾吞吐与不触发限流/超时。
const WRITE_BATCH = 20
// [假设] 单次导入条数上限。云函数默认超时 15s，2000 张纯文字分批写是保守值；
//        实际以「部署说明 §6 压测」为准，超限直接拒绝而非超时中途失败。
const MAX_ROWS = 2000
// [假设] 每行正文长度上限（字符），防止单行过大撑爆返回体/内存。
const MAX_FIELD_LEN = 2000

const REQUIRED_HEADERS = ['front', 'back']

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { code: 401, msg: 'no OPENID: call from mini program client' }

  // [假设] 一期只接受前端粘贴的 CSV 文本（event.csv）。
  //        若走云存储文件，前端先 wx.cloud.downloadFile 读成文本再传入；二期再支持 fileID 直读。
  const csv = event.csv
  if (typeof csv !== 'string' || !csv.trim()) {
    return { code: 400, msg: 'event.csv required (pasted CSV text)' }
  }

  try {
    const parsed = parseCsv(csv)
    const mapped = mapRows(parsed)
    if (mapped.errors.length) {
      return { code: 400, msg: 'CSV 格式错误', errors: mapped.errors.slice(0, 10) }
    }
    const rows = mapped.rows
    if (rows.length === 0) return { code: 400, msg: 'no valid data rows' }
    if (rows.length > MAX_ROWS) {
      return { code: 413, msg: `rows ${rows.length} exceeds limit ${MAX_ROWS}` }
    }

    // 去重分两层：① 输入内按 ankiGuid 去重；② 查库排除已存在的 guid（支持重复导入不覆盖进度）。
    const dedup = dedupeInInput(rows)
    const existing = await fetchExistingGuids(openid, dedup.guids)
    const fresh = dedup.rows.filter((r) => !existing.has(r.ankiGuid))

    const stats = await batchInsert(openid, fresh)

    return {
      code: 0,
      parsedRows: rows.length,
      dupInFile: dedup.dupCount,
      dupInDb: dedup.rows.length - fresh.length,
      inserted: stats.inserted,
      failed: stats.failed,
      failedSamples: stats.failedSamples,
      // [假设] 写调用次数 ≈ 每卡 1 次 cards.add + 1 次 reviews.add；用于对账资源点。
      approxWriteCalls: stats.inserted * 2,
    }
  } catch (err) {
    console.error('[importAnkiCsv] error', err)
    return { code: 500, msg: err.message || String(err) }
  }
}

// ---------- CSV 解析（RFC4180 子集：引号包裹、双引号转义、逗号分隔、CRLF/LF 换行） ----------

// [假设] 一期约定：逗号分隔；字段含逗号/换行/引号时用双引号包裹，字段内引号写成两个双引号；
//        首行为表头。生成器会写 BOM，这里一并剥离。分号/Tab 分隔的 Anki 导出需用户在
//        Excel/文本编辑器里先转逗号（见 CSV导入格式规范.md）。
function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1 } else { inQuotes = false }
      } else {
        field += ch
      }
      continue
    }
    // 仅「字段起始处」的引号视为 quoted 字段开始；出现在字段中间的裸引号
    // 当普通字符保留。这样既兼容标准 RFC4180，也容错 Excel/Anki 常见的不规范导出
    // （标准写法应把字段整体加引号并把内部引号双写："a ""b"" c"）。
    if (ch === '"' && field === '') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(field); rows.push(row); row = []; field = ''
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  // 丢弃全空行
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

// 表头映射：front/back 必填；tags(空格分隔)、guid、deckId 可选。列名忽略大小写与首尾空格。
function mapRows(rows) {
  const errors = []
  if (rows.length === 0) return { rows: [], errors: ['empty csv'] }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  for (const req of REQUIRED_HEADERS) {
    if (!header.includes(req)) errors.push(`missing required column: ${req}`)
  }
  if (errors.length) return { rows: [], errors }

  const idx = (name) => header.indexOf(name)
  const iFront = idx('front')
  const iBack = idx('back')
  const iTags = idx('tags')
  const iGuid = idx('guid')
  const iDeck = idx('deckid')

  const out = []
  for (let r = 1; r < rows.length; r += 1) {
    const cols = rows[r]
    const front = (cols[iFront] || '').trim()
    const back = (cols[iBack] || '').trim()
    if (!front && !back) continue
    if (front.length > MAX_FIELD_LEN || back.length > MAX_FIELD_LEN) {
      errors.push(`row ${r + 1}: field exceeds ${MAX_FIELD_LEN} chars`); continue
    }
    out.push({
      front,
      back,
      tags: iTags >= 0 ? (cols[iTags] || '').trim().split(/\s+/).filter(Boolean) : [],
      deckId: iDeck >= 0 ? (cols[iDeck] || '').trim() : '',
      // 去重键：优先用 Anki guid；否则对正文做稳定哈希（同一正文跨文件导入也能去重）。
      ankiGuid: iGuid >= 0 && (cols[iGuid] || '').trim()
        ? (cols[iGuid] || '').trim()
        : 'h:' + stableHash(front + '\x1f' + back),
    })
  }
  return { rows: out, errors }
}

// 输入内去重：同一份 CSV 里重复 guid 只留第一条。
function dedupeInInput(rows) {
  const seen = new Set()
  const kept = []
  let dupCount = 0
  for (const r of rows) {
    if (seen.has(r.ankiGuid)) { dupCount += 1; continue }
    seen.add(r.ankiGuid); kept.push(r)
  }
  return { rows: kept, guids: Array.from(seen), dupCount }
}

// 查库排除已存在 guid（重复导入不产生新卡、不覆盖已有 reviews 进度）。
async function fetchExistingGuids(openid, guids) {
  const found = new Set()
  for (let i = 0; i < guids.length; i += IN_BATCH) {
    const part = guids.slice(i, i + IN_BATCH)
    const res = await db.collection('cards')
      .where({ _openid: openid, ankiGuid: db.command.in(part) })
      .field({ ankiGuid: true })
      .get()
    for (const d of res.data) found.add(d.ankiGuid)
  }
  return found
}

// add 只支持单条（官方「插入数据」页）：受控并发分批写，每卡写 cards + reviews 两条。
// 关键：云函数 add 不会自动注入 _openid，必须显式写，否则前端按 _openid 读不到。
async function batchInsert(openid, rows) {
  let inserted = 0
  const failedSamples = []
  const now = new Date()

  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const part = rows.slice(i, i + WRITE_BATCH)
    const results = await Promise.all(part.map(async (r) => {
      try {
        const card = {
          _openid: openid, // 必须显式写：云函数端不自动加
          deckId: r.deckId,
          front: r.front,
          back: r.back,
          tags: r.tags,
          source: 'anki',
          ankiGuid: r.ankiGuid,
          createdAt: now,
        }
        const cardRes = await db.collection('cards').add({ data: card })
        // 每张新卡初始化一条 SRS 排程；正文与排程解耦，日后重导入不会冲掉复习进度。
        await db.collection('reviews').add({ data: {
          _openid: openid,
          cardId: cardRes._id,
          dueDate: todayStr(now), // 新卡当期即进入今日待复习
          interval: 0,
          easeFactor: 2.5,
          repetitions: 0,
          lapses: 0,
          lastReviewed: null,
          updatedAt: now,
        } })
        return { ok: true }
      } catch (e) {
        return { ok: false, guid: r.ankiGuid, err: e.message || String(e) }
      }
    }))
    for (const res of results) {
      if (res.ok) inserted += 1
      else if (failedSamples.length < 10) failedSamples.push(res)
    }
  }
  return { inserted, failed: rows.length - inserted, failedSamples }
}

// 稳定哈希（djb2 变体）：无 guid 列时生成可复现的去重键。[假设] 算法可替换。
function stableHash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function todayStr(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
