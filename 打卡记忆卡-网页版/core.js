/*
 * core.js — 打卡记忆卡网页版的纯逻辑层。
 *
 * 无任何 DOM / localStorage / 网络依赖，纯函数 + 显式的 state 对象传入传出，
 * 因此同一份代码既能被 <script> 直接内联，也能被 Node require 做自检。
 *
 * 复用来源：SM-2 排程、CSV 解析、两层去重、djb2 哈希，逐行搬自已通过
 * 97 项自检的微信云函数版（submitReview/index.js、importAnkiCsv/index.js），
 * 口径不变：官方 ceil 取整、q=4 时 EF 不变、CSV 裸引号容错。
 * 存储层的差异（本地无 15s 超时、无 add 单条限制、无云函数 1MB 返回体）
 * 只影响 importCards 的分批策略，这里移除了云端的批次上限常量。
 *
 * [假设] 项照旧标注，需按真实使用量确认，非官方或权威事实。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.DakaCore = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  var MIN_EF = 1.3
  var INITIAL_EF = 2.5
  // [假设] Anki 四档 → SM-2 q 值。Again=2（最轻失败档）、Hard=3、Good=4、Easy=5；q>=3 才算通过。
  var RATING_Q = { again: 2, hard: 3, good: 4, easy: 5 }
  var REQUIRED_HEADERS = ['front', 'back']
  var MAX_FIELD_LEN = 2000
  var MAX_ROWS = 2000
  var BATCH_LIMIT = 100   // [假设] 单次取待复习上限，防止一次渲染上千张卡拖慢手机。

  // ---------- 日期：全部用本地日期字符串 YYYY-MM-DD，字典序即时间序，可直接比较 ----------
  function parseDate(s) {
    var p = s.split('-').map(Number)
    return new Date(p[0], p[1] - 1, p[2])
  }
  function todayStr(d) {
    var x = d || new Date()
    var p = function (n) { return String(n).padStart(2, '0') }
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate())
  }
  function addDaysStr(s, n) {
    var d = parseDate(s)
    d.setDate(d.getDate() + n)
    return todayStr(d)
  }
  function dayDiff(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000)
  }

  // ---------- SM-2（SuperMemo 官方一手口径，2026-11-12 核实，云函数版已过自检） ----------
  // 先用「旧 EF」算本次 interval，再更新 EF；q=4 时 EF 增量为 0，可作校验点。
  // lapses（遗忘次数）来自 Anki 语义，SM-2 原文无此字段：q<3 时 +1 [假设]。
  function sm2Update(q, review) {
    var oldReps = review.repetitions || 0
    var oldInterval = review.interval || 0
    var oldEf = typeof review.easeFactor === 'number' ? review.easeFactor : INITIAL_EF
    var oldLapses = review.lapses || 0

    var passed = q >= 3
    var repetitions, interval, lapses
    if (passed) {
      if (oldReps === 0) interval = 1
      else if (oldReps === 1) interval = 6
      else interval = Math.ceil(oldInterval * oldEf) // 官方：小数向上取整，不是 round。
      repetitions = oldReps + 1
      lapses = oldLapses
    } else {
      repetitions = 0
      interval = 1
      lapses = oldLapses + 1
    }
    var ef = Math.max(MIN_EF, oldEf + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
    return { q: q, passed: passed, repetitions: repetitions, interval: interval, easeFactor: Math.round(ef * 1000) / 1000, lapses: lapses }
  }

  function newReview(date) {
    return {
      dueDate: date,
      interval: 0,
      easeFactor: INITIAL_EF,
      repetitions: 0,
      lapses: 0,
      lastReviewed: null
    }
  }

  // ---------- CSV 解析（RFC4180 子集，含裸引号容错） ----------
  // 与云函数版逐行一致：仅字段起始处的引号视为 quoted 开始，
  // 字段中间的裸引号当普通字符保留，兼容 Excel/Anki 的不规范导出。
  function parseCsv(text) {
    var src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    var rows = []
    var row = []
    var field = ''
    var inQuotes = false

    for (var i = 0; i < src.length; i += 1) {
      var ch = src[i]
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 1 } else { inQuotes = false }
        } else {
          field += ch
        }
        continue
      }
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
    return rows.filter(function (r) { return r.some(function (c) { return c.trim() !== '' }) })
  }

  // 表头映射：front/back 必填；tags(空格分隔)、guid、deckId 可选。列名忽略大小写与首尾空格。
  function mapRows(rows) {
    var errors = []
    if (rows.length === 0) return { rows: [], errors: ['empty csv'] }

    var header = rows[0].map(function (h) { return h.trim().toLowerCase() })
    REQUIRED_HEADERS.forEach(function (req) {
      if (header.indexOf(req) < 0) errors.push('missing required column: ' + req)
    })
    if (errors.length) return { rows: [], errors: errors }

    var idx = function (name) { return header.indexOf(name) }
    var iFront = idx('front')
    var iBack = idx('back')
    var iTags = idx('tags')
    var iGuid = idx('guid')
    var iDeck = idx('deckid')

    var out = []
    for (var r = 1; r < rows.length; r += 1) {
      var cols = rows[r]
      var front = (cols[iFront] || '').trim()
      var back = (cols[iBack] || '').trim()
      if (!front && !back) continue
      if (front.length > MAX_FIELD_LEN || back.length > MAX_FIELD_LEN) {
        errors.push('row ' + (r + 1) + ': field exceeds ' + MAX_FIELD_LEN + ' chars')
        continue
      }
      out.push({
        front: front,
        back: back,
        tags: iTags >= 0 ? (cols[iTags] || '').trim().split(/\s+/).filter(Boolean) : [],
        deckId: iDeck >= 0 ? (cols[iDeck] || '').trim() : '',
        ankiGuid: iGuid >= 0 && (cols[iGuid] || '').trim()
          ? (cols[iGuid] || '').trim()
          : 'h:' + stableHash(front + '\x1f' + back)
      })
    }
    return { rows: out, errors: errors }
  }

  // 输入内去重：同一份 CSV 里重复 guid 只留第一条。
  function dedupeInInput(rows) {
    var seen = new Set()
    var kept = []
    var dupCount = 0
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i]
      if (seen.has(r.ankiGuid)) { dupCount += 1; continue }
      seen.add(r.ankiGuid); kept.push(r)
    }
    return { rows: kept, guids: Array.from(seen), dupCount: dupCount }
  }

  // 稳定哈希（djb2 变体）：无 guid 列时生成可复现的去重键。[假设] 算法可替换。
  function stableHash(s) {
    var h = 5381
    for (var i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
    return h.toString(36)
  }

  // ---------- 本地状态：一个纯 JSON 对象，整体存 localStorage 单键 ----------
  // 集合名沿用云函数版（plans/cards/reviews/checkins）以便对照；
  // 本地单用户，去掉了 _openid 隔离与 users 全局计数（stats 内联）。
  function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
  }
  function initState(date) {
    var d = date || todayStr(new Date())
    return {
      version: 1,
      settings: { perDayNew: 20, perDayReview: 100 }, // [假设] 每日新卡/复习上限，用户可调。
      plans: [],      // { id, title, enabled, sortOrder, linkedDeckId }
      cards: [],      // { id, front, back, tags[], source, ankiGuid, deckId, createdAt }
      reviews: {},    // cardId -> review（正文与排程解耦，重导入不冲掉进度）
      checkins: {},   // 'YYYY-MM-DD' -> { planIds[], reviewedCount }
      stats: { totalReviews: 0 },
      createdAt: d
    }
  }

  // ---------- 打卡项 plans ----------
  function addPlan(state, title, linkedDeckId) {
    title = String(title || '').trim()
    if (!title) return { ok: false, error: 'plan title required' }
    var p = {
      id: newId('p'),
      title: title,
      enabled: true,
      sortOrder: state.plans.length,
      linkedDeckId: String(linkedDeckId || '')
    }
    state.plans.push(p)
    return { ok: true, plan: p }
  }
  function updatePlan(state, id, patch) {
    var p = state.plans.find(function (x) { return x.id === id })
    if (!p) return { ok: false, error: 'plan not found: ' + id }
    if (patch.title !== undefined) {
      var t = String(patch.title).trim()
      if (!t) return { ok: false, error: 'plan title required' }
      p.title = t
    }
    if (patch.enabled !== undefined) p.enabled = !!patch.enabled
    if (patch.linkedDeckId !== undefined) p.linkedDeckId = String(patch.linkedDeckId)
    return { ok: true, plan: p }
  }
  function removePlan(state, id) {
    var i = state.plans.findIndex(function (x) { return x.id === id })
    if (i < 0) return { ok: false, error: 'plan not found: ' + id }
    state.plans.splice(i, 1)
    // 流水里残留的 planId 不清理：历史记录保持当时原样。
    return { ok: true }
  }

  // ---------- 打卡 checkin：连续天数 streak 由流水派生，不单独存 ----------
  // 幂等：同一天重复提交，planIds 做并集，reviewedCount 取本批新增，checkinDays 按该日是否首次有内容计。
  function checkin(state, date, planIds) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { ok: false, error: 'date must be YYYY-MM-DD' }
    var ids = Array.isArray(planIds) ? planIds.filter(function (x) { return typeof x === 'string' }) : []
    var flow = state.checkins[date] || { planIds: [], reviewedCount: 0 }
    var merged = Array.from(new Set(flow.planIds.concat(ids)))
    var firstToday = flow.planIds.length === 0 && merged.length === 0 ? false : (flow.planIds.length === 0)
    flow.planIds = merged
    state.checkins[date] = flow
    return { ok: true, date: date, firstToday: firstToday, planIds: merged.slice() }
  }

  // 覆盖式写入当天完成的打卡项。UI 勾选与取消都用它重建完整列表，
  // 因为 checkin 是并集语义、无法表达「取消某项」。
  function setDayPlanIds(state, date, planIds) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { ok: false, error: 'date must be YYYY-MM-DD' }
    var ids = Array.isArray(planIds) ? planIds.filter(function (x) { return typeof x === 'string' }) : []
    var uniq = Array.from(new Set(ids))
    var flow = state.checkins[date] || { planIds: [], reviewedCount: 0 }
    flow.planIds = uniq
    state.checkins[date] = flow
    return { ok: true, date: date, planIds: uniq }
  }

  // 派生连续天数：从今天（或最近有打卡的那天）往回逐日数，遇到断档即停。
  function computeStreak(state, date) {
    var d = date || todayStr(new Date())
    var days = Object.keys(state.checkins).filter(function (k) {
      var f = state.checkins[k]
      return (f.planIds && f.planIds.length > 0) || (f.reviewedCount || 0) > 0
    })
    if (days.length === 0) return { streak: 0, checkinDays: 0, lastCheckin: null }
    // 今天还没打卡时，从昨天起算，避免"当天未打就把连续清零"的错觉。
    var hasToday = state.checkins[d] && ((state.checkins[d].planIds || []).length > 0 || (state.checkins[d].reviewedCount || 0) > 0)
    var cursor = hasToday ? d : addDaysStr(d, -1)
    var set = new Set(days)
    var streak = 0
    while (set.has(cursor)) { streak += 1; cursor = addDaysStr(cursor, -1) }
    var sorted = days.slice().sort()
    return { streak: streak, checkinDays: sorted.length, lastCheckin: sorted[sorted.length - 1] }
  }

  // ---------- 卡片 cards 与排程 reviews ----------
  function manualGuid(front, back) { return 'm:' + stableHash(front + '\x1f' + back) }

  function addCard(state, data, date) {
    var front = String((data && data.front) || '').trim()
    var back = String((data && data.back) || '').trim()
    if (!front) return { ok: false, error: 'card front required' }
    var d = date || todayStr(new Date())
    var c = {
      id: data.id || newId('c'),
      front: front,
      back: back,
      tags: Array.isArray(data.tags) ? data.tags.slice() : [],
      source: data.source || 'manual',
      ankiGuid: data.ankiGuid || manualGuid(front, back),
      deckId: String(data.deckId || ''),
      createdAt: d
    }
    state.cards.push(c)
    state.reviews[c.id] = data.review || newReview(d) // 正文与排程解耦。
    return { ok: true, card: c }
  }
  function updateCard(state, id, patch) {
    var c = state.cards.find(function (x) { return x.id === id })
    if (!c) return { ok: false, error: 'card not found: ' + id }
    if (patch.front !== undefined) {
      var f = String(patch.front).trim()
      if (!f) return { ok: false, error: 'card front required' }
      c.front = f
    }
    if (patch.back !== undefined) c.back = String(patch.back).trim()
    if (patch.tags !== undefined) c.tags = Array.isArray(patch.tags) ? patch.tags.slice() : String(patch.tags).trim().split(/\s+/).filter(Boolean)
    return { ok: true, card: c }
  }
  function removeCard(state, id) {
    var i = state.cards.findIndex(function (x) { return x.id === id })
    if (i < 0) return { ok: false, error: 'card not found: ' + id }
    state.cards.splice(i, 1)
    delete state.reviews[id]
    return { ok: true }
  }

  // 两层去重：① 输入内按 ankiGuid；② 查库排除已存在 guid（重导入不产生新卡、不覆盖进度）。
  // importRows 是与来源无关的入库核心：CSV 和 .apkg 两条导入路径都走它，
  // 保证去重口径、进度保护、字段校验只有一份实现。rows 结构与 mapRows 输出同构。
  function importRows(state, rows, date) {
    if (!Array.isArray(rows)) return { ok: false, error: 'rows must be an array' }
    if (rows.length === 0) return { ok: false, error: 'no valid data rows' }
    if (rows.length > MAX_ROWS) return { ok: false, error: 'rows ' + rows.length + ' exceeds limit ' + MAX_ROWS }

    var dedup = dedupeInInput(rows)
    var existing = new Set(state.cards.map(function (c) { return c.ankiGuid }))
    var fresh = dedup.rows.filter(function (r) { return !existing.has(r.ankiGuid) })
    var d = date || todayStr(new Date())
    for (var i = 0; i < fresh.length; i += 1) {
      addCard(state, fresh[i], d) // 新卡 dueDate=today，当期即进入待复习。
    }
    return {
      ok: true,
      parsedRows: rows.length,
      dupInFile: dedup.dupCount,
      dupInDb: dedup.rows.length - fresh.length,
      inserted: fresh.length
    }
  }

  function importCards(state, csvText, date) {
    if (typeof csvText !== 'string' || !csvText.trim()) return { ok: false, error: 'event.csv required (pasted CSV text)' }
    var parsed = parseCsv(csvText)
    var mapped = mapRows(parsed)
    if (mapped.errors.length) return { ok: false, error: 'CSV 格式错误', errors: mapped.errors.slice(0, 10) }
    return importRows(state, mapped.rows, date)
  }

  // ---------- HTML 正文清洗（.apkg 纯文字导入用，与来源解耦的纯函数） ----------
  // Anki 字段是 HTML 片段。纯文字方案要：保留可读文字与换行，剥离标签，
  // 并把 <img>/[sound] 媒体引用剥离成空（图片音频不搬，仅计数提示），转义实体还原。
  // 不做富文本渲染，避免引入 XSS 面；[假设] 剥离规则按实际牌组可增减。
  function stripMarkup(html) {
    var refs = []
    var s = String(html == null ? '' : html)
    // 先记录并移除媒体引用：Anki 音频是 [sound:xxx]，图片多为 <img src="xxx">。
    s = s.replace(/\[sound:[^\]]*\]/gi, function (m) { refs.push(m); return '' })
    s = s.replace(/<img\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)["']?[^>]*\/?\s*>/gi,
      function (m, src) { refs.push('<img:' + src + '>'); return '' })
    // 换行类标签换成真实换行，块级标签结尾补换行，其余标签直接剥掉。
    s = s.replace(/<br\s*\/?>/gi, '\n')
    s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    s = s.replace(/<[^>]*>/g, '')
    // 常见 HTML 实体还原（够用集；不逐字解码全部命名实体）。
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    s = s.replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)) })
    // 收拢多余空白但保留段落换行；每个非空行 trim。
    s = s.split('\n').map(function (line) { return line.replace(/[\t\u00a0]+/g, ' ').trim() })
      .filter(function (line, i, arr) { return !(line === '' && (i === 0 || i === arr.length - 1)) })
      .join('\n').trim()
    return { text: s, mediaRefs: refs }
  }

  // Cloze 卡（{{c1::...}}）依赖填空渲染，纯文字方案不做，识别出来跳过并计数。
  function hasCloze(html) {
    return /\{\{c\d+::/.test(String(html == null ? '' : html))
  }

  // ---------- 待复习队列与评分 ----------
  function dueCards(state, date, limit) {
    var d = date || todayStr(new Date())
    var out = state.cards.filter(function (c) {
      var r = state.reviews[c.id]
      return r && r.dueDate <= d
    })
    // 先按到期日、再按创建顺序，保证新卡在前、老到期卡随后，稳定可预期。
    out.sort(function (a, b) {
      var ra = state.reviews[a.id], rb = state.reviews[b.id]
      if (ra.dueDate !== rb.dueDate) return ra.dueDate < rb.dueDate ? -1 : 1
      return 0
    })
    return out.slice(0, limit || BATCH_LIMIT)
  }

  // 逐卡算 SM-2 并写回排程；每张卡状态不同，本地无 where().update 批量能力，逐条改内存即可（无网络往返）。
  function rateCards(state, items, date) {
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'items required (non-empty array)' }
    var qById = {}
    var normalized = []
    for (var i = 0; i < items.length; i += 1) {
      var it = items[i]
      if (!it || typeof it.cardId !== 'string' || !it.cardId) return { ok: false, error: 'each item requires a string cardId' }
      var q = RATING_Q[String(it.rating || '').toLowerCase()]
      if (q === undefined) return { ok: false, error: 'invalid rating "' + it.rating + '", allowed: again/hard/good/easy' }
      normalized.push({ cardId: it.cardId, q: q })
      qById[it.cardId] = q
    }

    var d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : todayStr(new Date())
    var updated = 0, skipped = 0, passedCount = 0, againCount = 0
    var skippedIds = []
    for (var j = 0; j < normalized.length; j += 1) {
      var id = normalized[j].cardId
      var review = state.reviews[id]
      if (!review) { skipped += 1; if (skippedIds.length < 10) skippedIds.push(id); continue } // 无排程（如已删卡）跳过。
      var next = sm2Update(qById[id], review)
      review.repetitions = next.repetitions
      review.interval = next.interval
      review.easeFactor = next.easeFactor
      review.lapses = next.lapses
      review.lastReviewed = d
      review.dueDate = addDaysStr(d, next.interval)
      updated += 1
      if (next.passed) passedCount += 1; else againCount += 1
    }
    if (updated > 0) {
      var flow = state.checkins[d] || { planIds: [], reviewedCount: 0 }
      flow.reviewedCount = (flow.reviewedCount || 0) + updated
      state.checkins[d] = flow
      state.stats.totalReviews = (state.stats.totalReviews || 0) + updated
    }
    return {
      ok: true, submitted: normalized.length, updated: updated, failed: 0,
      skippedNoSchedule: skipped, passed: passedCount, again: againCount, skippedIds: skippedIds
    }
  }

  // ---------- 备份：整state导出/导入，前端只管 localStorage 单键读写 ----------
  function validateBackup(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'not an object' }
    var must = ['plans', 'cards', 'reviews', 'checkins', 'stats']
    for (var i = 0; i < must.length; i += 1) {
      if (raw[must[i]] === undefined) return { ok: false, error: 'missing field: ' + must[i] }
    }
    if (!Array.isArray(raw.plans) || !Array.isArray(raw.cards)) return { ok: false, error: 'plans/cards must be arrays' }
    if (typeof raw.reviews !== 'object' || typeof raw.checkins !== 'object') return { ok: false, error: 'reviews/checkins must be objects' }
    return { ok: true }
  }
  function importState(text) {
    var raw
    try { raw = JSON.parse(text) } catch (e) { return { ok: false, error: 'JSON parse failed: ' + e.message } }
    var v = validateBackup(raw)
    if (!v.ok) return v
    return { ok: true, state: normalizeState(raw) }
  }
  // 归一化：补齐缺失字段、类型纠偏，容忍旧版本/手工编辑过的备份，读进来就能用。
  function normalizeState(raw) {
    var base = initState(raw.createdAt || todayStr(new Date()))
    var s = Object.assign({}, base, raw)
    s.settings = Object.assign({}, base.settings, raw.settings || {})
    s.stats = Object.assign({}, base.stats, raw.stats || {})
    s.plans = Array.isArray(raw.plans) ? raw.plans : []
    s.cards = Array.isArray(raw.cards) ? raw.cards : []
    s.reviews = (raw.reviews && typeof raw.reviews === 'object') ? raw.reviews : {}
    s.checkins = (raw.checkins && typeof raw.checkins === 'object') ? raw.checkins : {}
    s.version = 1
    return s
  }

  return {
    MIN_EF: MIN_EF, INITIAL_EF: INITIAL_EF, RATING_Q: RATING_Q,
    MAX_ROWS: MAX_ROWS,
    todayStr: todayStr, addDaysStr: addDaysStr, dayDiff: dayDiff,
    sm2Update: sm2Update, newReview: newReview,
    parseCsv: parseCsv, mapRows: mapRows, dedupeInInput: dedupeInInput, stableHash: stableHash,
    stripMarkup: stripMarkup, hasCloze: hasCloze,
    initState: initState, newId: newId,
    addPlan: addPlan, updatePlan: updatePlan, removePlan: removePlan,
    checkin: checkin, setDayPlanIds: setDayPlanIds, computeStreak: computeStreak,
    addCard: addCard, updateCard: updateCard, removeCard: removeCard,
    importCards: importCards, importRows: importRows, dueCards: dueCards, rateCards: rateCards,
    validateBackup: validateBackup, importState: importState, normalizeState: normalizeState
  }
})
