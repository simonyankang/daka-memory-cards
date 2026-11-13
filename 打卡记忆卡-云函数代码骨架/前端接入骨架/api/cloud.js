// api/cloud.js —— 四个云函数的统一调用封装 + 本地缓存兜底
//
// 设计原则（对应实现要点 §2.3）：
//   - 前端不直连数据库，一律 wx.cloud.callFunction；错误码统一在此收口。
//   - 本地缓存（wx.setStorageSync，单 key ≤1MB/总 ≤10MB）用于秒开，云端静默增量同步。
//   - OPENID 由云函数 getWXContext 注入，前端绝不传、也不信前端传来的 openid。
//
// 使用前：app.js 里 wx.cloud.init({ env: wx.cloud.DYNAMIC_CURRENT_ENV, traceUser: true })

const CACHE_KEY = {
  today: (date) => `cache:today:${date}`, // 只缓存当天，跨天自然失效
  profile: 'cache:profile',
}

function call(name, data = {}) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: (res) => {
        const r = res.result || {}
        if (r.code === 0) return resolve(r)
        // 业务错误（400/401/413）不当作网络异常，交给调用方按需提示
        reject(Object.assign(new Error(r.msg || 'business error'), { code: r.code, detail: r }))
      },
      fail: (err) => reject(Object.assign(new Error(err.errMsg || 'callFunction failed'), { code: -1 })),
    })
  })
}

// ① 取当天待办：先返回本地缓存秒开，再后台拉云端覆盖（stale-while-revalidate）
async function getToday(date, { onCache, fresh = true } = {}) {
  const d = date || todayStr()
  const key = CACHE_KEY.today(d)
  let cached = null
  try { cached = wx.getStorageSync(key) || null } catch (e) {}
  if (cached && onCache) onCache(cached) // 先用缓存渲染

  if (!fresh && cached) return cached
  const data = await call('getToday', { date: d })
  try { wx.setStorageSync(key, data) } catch (e) {}
  return data
}

// ② 打卡
function checkin(date, planIds) {
  return call('checkin', { date: date || todayStr(), planIds: planIds || [] })
    .then((r) => { try { wx.removeStorageSync(CACHE_KEY.today(date || todayStr())) } catch (e) {}; return r })
}

// ③ 提交复习反馈（批量）
function submitReview(items, date) {
  return call('submitReview', { items, date: date || todayStr() })
    .then((r) => { try { wx.removeStorageSync(CACHE_KEY.today(date || todayStr())) } catch (e) {}; return r })
}

// ④ 导入 CSV（一期：前端读文件成文本再传）
function importAnkiCsv(csv) {
  return call('importAnkiCsv', { csv })
}

// 前端读 CSV 文件为 UTF-8 文本（配合 importAnkiCsv）
function readCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath, encoding: 'utf8',
      success: (r) => resolve(r.data),
      fail: (e) => reject(new Error(e.errMsg || 'read csv failed')),
    })
  })
}

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

module.exports = { call, getToday, checkin, submitReview, importAnkiCsv, readCsvFile, todayStr, CACHE_KEY }
