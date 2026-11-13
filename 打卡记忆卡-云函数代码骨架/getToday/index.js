// getToday —— 一次云函数调用聚合「当天打卡计划 + 今日待复习卡 + 用户统计」
//
// 设计目标（对应实现要点 §2.1）：把小程序端「一次只能读 20 条、每读一次算 1 次调用」
// 的多次往返，压成云函数内批量读 + 聚合后一次返回（纯文字，远低于 1MB 返回体上限）。
//
// 依据（官方一手，采集 2026-11-12）：
//   - cloud.init / getWXContext().OPENID：微信开放文档「我的第一个云函数」「初始化」
//   - 云函数端单次 get 上限 100 条：官方「查询数据」页
//   - _.in / _.lte / _.eq 指令、_.inc 原子自增：官方「更新数据」「指令」页
//   - 只返回 Promise：wx-server-sdk 云函数端不支持 success/fail/complete 回调
// 凡官方未给出明确数字的（如 _.in 元素上限、单次导入上限），均标 [假设] 并做防御。

const cloud = require('wx-server-sdk')

// 云函数端固定写法：让数据库请求落到本函数所在环境，勿用 getWXContext().ENV 替代。
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// 云函数端单次 get 上限 100 条（官方文档明确）。分页步长与此对齐。
const PAGE_SIZE = 100
// [假设] 官方未写明 _.in 数组的元素上限，取 20 作保守分批；可按压测结果调大。
const IN_BATCH = 20
// [假设] 防止单日积压过多导致函数超时（默认 15s），给待复习批次封顶。
const MAX_DUE = 500
// 小程序端一次读上限 20 条；返回的 plans 直接给前端，故取 20。
const PLAN_LIMIT = 20

exports.main = async (event = {}) => {
  // OPENID 由小程序调用云函数时后端自动注入，前端无法伪造，可直接作为数据隔离键。
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  if (!openid) return { code: 401, msg: 'no OPENID: call from mini program client' }

  // 约定日期用 'YYYY-MM-DD' 字符串比较（与 CSV 导入、reviews.dueDate 保持一致），
  // 规避 Date 对象在不同时区下的边界误差。允许前端传 date 覆盖（便于测试/补签）。
  const date = /^\d{4}-\d{2}-\d{2}$/.test(event.date || '')
    ? event.date
    : todayStr(new Date())

  try {
    // [并行] 用户统计 + 打卡计划 + 今日待复习排程，三者无依赖，同时发起省时延。
    const [userRes, plansRes, dueReviews] = await Promise.all([
      db.collection('users').where({ _openid: openid }).limit(1).get(),
      db.collection('plans')
        .where({ _openid: openid, enabled: _.eq(true) })
        .orderBy('sortOrder', 'asc')
        .limit(PLAN_LIMIT)
        .get(),
      fetchDueReviews(openid, date),
    ])

    // 用排程里的 cardId 批量取卡片正文（_.in 分批），并按 _id 关联回排程。
    const cards = await fetchCardsByIds(openid, dueReviews.cardIds)
    const cardMap = {}
    for (const c of cards) cardMap[c._id] = c
    const reviewList = dueReviews.rows.map((r) => ({
      ...r,
      card: cardMap[r.cardId] || null, // 排程存在但卡片缺失（如被删）时置空，前端容错
    }))

    return {
      code: 0,
      date,
      user: userRes.data[0] || null,
      plans: plansRes.data,
      reviews: reviewList,
      // 元信息：便于对账实际数据库调用次数，验证是否落在省档。
      _meta: {
        dbReadCalls: 2 + dueReviews.readCalls + Math.ceil(dueReviews.cardIds.length / IN_BATCH),
        dueCount: reviewList.length,
        truncated: dueReviews.truncated,
      },
    }
  } catch (err) {
    console.error('[getToday] error', err)
    return { code: 500, msg: err.message || String(err) }
  }
}

// 分页取出所有 dueDate <= 今天的排程（含逾期未复习的卡）。
// 索引依赖：reviews(_openid, dueDate)，见部署说明 §3。
async function fetchDueReviews(openid, date) {
  const rows = []
  let skip = 0
  let readCalls = 0
  let truncated = false
  for (;;) {
    const res = await db.collection('reviews')
      .where({ _openid: openid, dueDate: _.lte(date) })
      .orderBy('dueDate', 'asc')
      .skip(skip)
      .limit(PAGE_SIZE)
      .get()
    readCalls += 1
    rows.push(...res.data)
    if (res.data.length < PAGE_SIZE) break // 不足一页，说明已到尾
    skip += PAGE_SIZE
    if (rows.length >= MAX_DUE) { truncated = true; break }
  }
  const cardIds = Array.from(new Set(rows.map((r) => r.cardId).filter(Boolean)))
  return { rows, cardIds, readCalls, truncated }
}

// _.in 分批按 _id 取卡片正文；只投影渲染所需字段，进一步压返回体（≤1MB）。
async function fetchCardsByIds(openid, cardIds) {
  const out = []
  for (let i = 0; i < cardIds.length; i += IN_BATCH) {
    const part = cardIds.slice(i, i + IN_BATCH)
    const res = await db.collection('cards')
      .where({ _openid: openid, _id: _.in(part) })
      .field({ front: true, back: true, tags: true, deckId: true, ankiGuid: true })
      .limit(PAGE_SIZE)
      .get()
    out.push(...res.data)
  }
  return out
}

function todayStr(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
