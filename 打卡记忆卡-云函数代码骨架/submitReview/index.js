// submitReview —— 复习反馈：按 SM-2 批量更新卡片排程 + 原子累计复习数
//
// 对应实现要点 §1.4(reviews 排程字段)、§2.2(批量更新/_.inc 原子)。
// 每张卡旧状态不同，无法用一条 where().update() 统一改（不同于 _.inc），
// 故：_.in 分批读当前 reviews → 逐卡算 SM-2 → 受控并发 doc().update() 逐条写。
//
// SM-2 依据（SuperMemo 官方 supermemo.com「间隔重复的真实历史」，一手，2026-11-12）：
//   初始 EF=2.5；I(1)=1、I(2)=6、I(n)=I(n-1)×EF（小数向上取整）；
//   EF' = EF + (0.1 - (5-q)(0.08 + (5-q)0.02))；EF<1.3 置 1.3；
//   q 为 0-5 评分，q>=3 算答对；q=4 时 EF 不变（官方明确点出，可作校验点）。
// Anki 四档按钮语义：官方手册 studying 页；四档→q 的映射是实现约定，标 [假设]。
// 注意：Anki 现默认用 FSRS/自有算法并加 fuzz 扰动，本函数是可解释的 SM-2 子集，非 Anki 精确行为。

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const IN_BATCH = 20       // [假设] _.in 元素上限未写明，保守分批
const WRITE_BATCH = 20    // [假设] 并发写批大小，防限流/超时
const MAX_ITEMS = 100     // [假设] 单次提交卡数上限，云函数默认超时 15s
// [假设] Anki 四档 → SM-2 q 值。Again 取 2（答错但题目眼熟，最轻失败档）；
//        Hard=3(对但吃力)、Good=4(对但费力)、Easy=5(完美)。q>=3 才算通过。
const RATING_Q = { again: 2, hard: 3, good: 4, easy: 5 }
const MIN_EF = 1.3        // 官方 SM-2：EF 下限 1.3
const INITIAL_EF = 2.5    // 官方 SM-2：初始 EF 2.5

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { code: 401, msg: 'no OPENID: call from mini program client' }

  const items = Array.isArray(event.items) ? event.items : []
  if (items.length === 0) return { code: 400, msg: 'items required (non-empty array)' }
  if (items.length > MAX_ITEMS) {
    return { code: 413, msg: `items ${items.length} exceeds limit ${MAX_ITEMS}` }
  }
  // 校验：cardId 为字符串、rating 在四档内；非法项直接拒绝整批，避免部分写入难排查。
  const normalized = []
  for (const it of items) {
    if (!it || typeof it.cardId !== 'string' || !it.cardId) {
      return { code: 400, msg: 'each item requires a string cardId' }
    }
    const q = RATING_Q[String(it.rating || '').toLowerCase()]
    if (q === undefined) {
      return { code: 400, msg: `invalid rating "${it.rating}", allowed: again/hard/good/easy` }
    }
    normalized.push({ cardId: it.cardId, q })
  }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(event.date || '') ? event.date : todayStr(new Date())

  try {
    // 越权防护：只按「本人 _openid + 这些 cardId」查 reviews，查不到的 cardId 一律跳过。
    // 后续只更新这里查到的 review._id —— 前端伪造他人 cardId 不会命中，无法改他人数据。
    const cardIds = Array.from(new Set(normalized.map((n) => n.cardId)))
    const reviewMap = await fetchReviewsByCardIds(openid, cardIds)
    const qById = {}
    for (const n of normalized) qById[n.cardId] = n.q

    let updated = 0
    let failed = 0
    let passedCount = 0
    let againCount = 0
    const skipped = cardIds.filter((id) => !reviewMap[id]) // 无排程（如手工卡未初始化）
    const failedSamples = []
    const toUpdate = cardIds.filter((id) => reviewMap[id]).map((id) => ({
      review: reviewMap[id], newState: sm2Update(qById[id], reviewMap[id]),
    }))
    for (const r of toUpdate) { if (r.newState.q >= 3) passedCount++; else againCount++ }

    for (let i = 0; i < toUpdate.length; i += WRITE_BATCH) {
      const part = toUpdate.slice(i, i + WRITE_BATCH)
      const results = await Promise.all(part.map(async ({ review, newState }) => {
        try {
          await db.collection('reviews').doc(review._id).update({ data: {
            repetitions: newState.repetitions,
            interval: newState.interval,
            easeFactor: newState.easeFactor,
            lapses: newState.lapses,
            lastReviewed: date,
            dueDate: addDaysStr(date, newState.interval),
            updatedAt: new Date(),
          } })
          return true
        } catch (e) {
          return { err: e.message || String(e), cardId: review.cardId }
        }
      }))
      for (const res of results) {
        if (res === true) updated++
        else { failed++; if (failedSamples.length < 10) failedSamples.push(res) }
      }
    }

    // 原子累计：用户总复习数 + 今日流水 reviewedCount。_.inc 对不存在的字段会按增量初始化 [假设]。
    if (updated > 0) {
      await bumpUserReviewCount(openid, updated)
      await bumpFlowReviewedCount(openid, date, updated)
    }

    return {
      code: 0,
      submitted: normalized.length,
      updated,
      failed,
      skippedNoSchedule: skipped.length,
      passed: passedCount,
      again: againCount,
      approxWriteCalls: updated + (updated > 0 ? 3 : 0), // 每卡 1 次 update + 最多 3 次统计累加
      failedSamples,
    }
  } catch (err) {
    console.error('[submitReview] error', err)
    return { code: 500, msg: err.message || String(err) }
  }
}

// SM-2 单卡更新纯函数（导出供自检逐档验证）。返回本次算出的新排程状态。
// 顺序遵循经典 SM-2：先用「旧 EF」算本次 interval，再更新 EF（差异仅出现在 q≠4 时，[假设]）。
// lapses（遗忘次数）来自 Anki 语义，SM-2 原文无此字段：q<3 时 +1 [假设]。
function sm2Update(q, review) {
  const oldReps = review.repetitions || 0
  const oldInterval = review.interval || 0
  const oldEf = typeof review.easeFactor === 'number' ? review.easeFactor : INITIAL_EF
  const oldLapses = review.lapses || 0

  const passed = q >= 3
  let repetitions, interval, lapses
  if (passed) {
    if (oldReps === 0) interval = 1
    else if (oldReps === 1) interval = 6
    else interval = Math.ceil(oldInterval * oldEf) // 官方：小数向上取整
    repetitions = oldReps + 1
    lapses = oldLapses
  } else {
    repetitions = 0
    interval = 1
    lapses = oldLapses + 1
  }
  // 官方公式；q=4 时增量正好为 0（EF 不变），可作校验断言。
  const ef = Math.max(MIN_EF, oldEf + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
  return { q, passed, repetitions, interval, easeFactor: Math.round(ef * 1000) / 1000, lapses }
}
exports._sm2Update = sm2Update // 仅自检/调试用，非云函数入口

async function fetchReviewsByCardIds(openid, cardIds) {
  const map = {}
  for (let i = 0; i < cardIds.length; i += IN_BATCH) {
    const part = cardIds.slice(i, i + IN_BATCH)
    const res = await db.collection('reviews')
      .where({ _openid: openid, cardId: _.in(part) })
      .limit(100)
      .get()
    for (const r of res.data) map[r.cardId] = r
  }
  return map
}

async function bumpUserReviewCount(openid, n) {
  try {
    await db.collection('users').where({ _openid: openid })
      .update({ data: { totalReviews: _.inc(n), lastReviewAt: new Date() } })
  } catch (e) { console.error('[submitReview] bumpUserReviewCount failed (non-fatal)', e) }
}

async function bumpFlowReviewedCount(openid, date, n) {
  try {
    const flowId = `${openid}_${date}`
    await db.collection('checkins').doc(flowId)
      .update({ data: { reviewedCount: _.inc(n) } })
  } catch (e) {
    // 今日未打卡（无流水）时属正常，不报错、不创建幽灵流水。
  }
}

function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
function addDaysStr(s, n) {
  const d = parseDate(s); d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function todayStr(d) {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
