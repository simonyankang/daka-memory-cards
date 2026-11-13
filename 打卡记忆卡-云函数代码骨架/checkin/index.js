// checkin —— 每日打卡：原子自增统计 + 断签判断 + 幂等流水
//
// 对应实现要点 §1.1(users 统计预计算)、§1.5(checkins 流水可选)、§2.2(_.inc 原子更新)。
// 统计字段预计算在 users，避免每次打开全表 count；streak/checkinDays 用 _.inc 原子自增防并发错乱。
//
// 依据（官方一手，采集 2026-11-12）：
//   - cloud.init / getWXContext().OPENID：微信开放文档「我的第一个云函数」「初始化」
//   - _.inc 原子自增 / _.set / _.eq：官方「更新数据」页
//   - 云函数端 add 不自动注入 _openid，需显式写：微信开放社区官方精选帖
// 凡官方未给出明确数字的均标 [假设] 并做防御。

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// [假设] 打卡项 id 数量上限，防止前端传入超长数组撑爆单条文档。
const MAX_PLAN_IDS = 100

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { code: 401, msg: 'no OPENID: call from mini program client' }

  // 日期用 'YYYY-MM-DD' 字符串（与 getToday/importAnkiCsv/checkins.date 一致），规避时区边界。
  const date = /^\d{4}-\d{2}-\d{2}$/.test(event.date || '')
    ? event.date
    : todayStr(new Date())
  // planIds：当天完成的打卡项 id 数组，前端可选传入，仅用于流水回看。
  const planIds = Array.isArray(event.planIds)
    ? event.planIds.filter((x) => typeof x === 'string').slice(0, MAX_PLAN_IDS)
    : []

  try {
    // 幂等核心：用固定 _id = openid_date 建流水。云数据库 _id 全局唯一，
    // 重复 add 同 _id 会失败 → 以此挡住「同一天重复打卡 / 连点 / 并发双写」，
    // 不依赖「先查后写」的竞态判断。doc(_id).get() 先读一次给前端明确反馈。
    const flowId = `${openid}_${date}`
    const existed = await db.collection('checkins').doc(flowId).get().catch(() => ({ data: null }))
    if (existed && existed.data) {
      return { code: 0, alreadyCheckedIn: true, date, note: '今天已打卡，未重复计数' }
    }

    // 读取用户当前统计，判断连续天数（streak）要不要 +1 还是重置为 1。
    const userRes = await db.collection('users').where({ _openid: openid }).limit(1).get()
    const user = userRes.data[0]
    const yesterday = dateStr(addDays(parseDate(date), -1))

    const newUser = {
      _openid: openid, // 云函数端不自动注入，显式写
      checkinDays: 1,
      streak: 1,
      lastCheckin: date,
      createdAt: new Date(),
    }
    if (!user) {
      // 首次打卡：upsert 一条 users（用 _id 固定为 openid 防并发重复建档）。
      await db.collection('users').add({ data: { _id: openid, ...newUser } }).catch((e) => {
        // 并发下另一请求已建档：忽略「_id 已存在」，后续走原子累加分支。
        if (!/exist|duplicate|already/i.test(e.message || String(e))) throw e
      })
      await writeFlow(openid, flowId, date, planIds)
      return { code: 0, alreadyCheckedIn: false, firstCheckin: true, date, checkinDays: 1, streak: 1 }
    }

    // 已有用户：判断今天是否已算过（防止 checkins 被误删但 users 已计数的极端情况）。
    if (user.lastCheckin === date) {
      await writeFlow(openid, flowId, date, planIds)
      return { code: 0, alreadyCheckedIn: true, date, note: '统计已含今日，仅补写流水' }
    }

    const continuous = user.lastCheckin === yesterday
    // 关键：streak 用 _.inc(continuous ? 1 : 0) 做不到「断签重置为 1」，
    // 故断签走 _.set({streak:1})，连续走 _.inc(1)；checkinDays 一律 _.inc(1)。
    const updateData = continuous
      ? { checkinDays: _.inc(1), streak: _.inc(1), lastCheckin: date }
      : { checkinDays: _.inc(1), streak: _.set(1), lastCheckin: date }
    await db.collection('users').doc(user._id).update({ data: updateData })

    await writeFlow(openid, flowId, date, planIds)
    return {
      code: 0,
      alreadyCheckedIn: false,
      date,
      continuous,
      // [假设] 返回更新后的近似值；精确值前端下次 getToday 拉取为准（_.inc 不返回新值）。
      checkinDaysHint: (user.checkinDays || 0) + 1,
      streakHint: continuous ? (user.streak || 0) + 1 : 1,
    }
  } catch (err) {
    console.error('[checkin] error', err)
    return { code: 500, msg: err.message || String(err) }
  }
}

// 写打卡流水；_id 固定保证幂等。若与并发请求重复 add，忽略冲突即可。
async function writeFlow(openid, flowId, date, planIds) {
  try {
    await db.collection('checkins').add({ data: {
      _id: flowId,
      _openid: openid,
      date,
      planIds,
      reviewedCount: 0,
      createdAt: new Date(),
    } })
    return true
  } catch (e) {
    if (/exist|duplicate|already/i.test(e.message || String(e))) return false // 并发已写，视为成功
    throw e
  }
}

function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x }
function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function todayStr(d) { return dateStr(d) }
