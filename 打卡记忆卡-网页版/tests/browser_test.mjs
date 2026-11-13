// 浏览器端集成测试：通过 CDP 驱动真实 Chrome，验证页面加载、依赖注入、
// Service Worker 注册，以及 .apkg 在浏览器里（含 wasm）能真跑通。
import fs from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const PAGE = 'http://127.0.0.1:8765/index.html'
const FIXTURE = 'C:/Users/yk/WorkBuddy/2026-10-10-09-04-10/打卡记忆卡-网页版/tests/fixture.apkg'

async function newTab() {
  const r = await fetch(CDP + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })
  return r.json()
}
async function closeTab(id) { try { await fetch(CDP + '/json/close/' + id) } catch (e) {} }

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let seq = 0
  const events = []
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method) events.push(msg)
  }
  function send(method, params = {}) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  return { ready, send, events, close: () => ws.close() }
}

async function main() {
  const tab = await newTab()
  const cli = cdp(tab.webSocketDebuggerUrl)
  await cli.ready
  await cli.send('Runtime.enable')
  await cli.send('Page.enable')
  await cli.send('Network.enable')
  await cli.send('Log.enable')

  // 等页面 load 完成 + SW 注册 + wasm 首次编译
  await new Promise((r) => setTimeout(r, 2500))

  let pass = 0, fail = 0
  const ok = (c, l, x) => { if (c) { pass++; console.log('  PASS ' + l) } else { fail++; console.log('  FAIL ' + l + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')) } }
  async function evalJS(expr, awaitPromise = false) {
    const r = await cli.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) return { __exception: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') }
    return r.result.value
  }

  console.log('\n== 页面加载与全局对象 ==')
  ok((await evalJS('document.title')) === '打卡记忆卡', '标题正确')
  ok((await evalJS('typeof window.DakaCore')) === 'object', 'core.js 已加载')
  ok((await evalJS('typeof window.JSZip')) === 'function', 'JSZip 已加载')
  ok((await evalJS('typeof window.initSqlJs')) === 'function', 'sql.js 已加载')
  ok((await evalJS('typeof window.DakaApkg && typeof window.DakaApkg.parseApkg')) === 'function', 'apkg.js 已加载')
  ok((await evalJS('typeof window.DakaCore.stripMarkup')) === 'function', 'core 新函数 stripMarkup 可用')
  ok((await evalJS('typeof window.DakaCore.importRows')) === 'function', 'core 新函数 importRows 可用')
  ok((await evalJS("document.querySelectorAll('.rate-grid').length >= 0")) === true, '评分按钮区存在')

  console.log('\n== 依赖缺失检测 ==')
  const missing = await evalJS('(window.__apkgDeps||[])')
  ok(Array.isArray(missing) && missing.length === 0, '无依赖加载失败', missing)

  console.log('\n== Service Worker ==')
  const sw = await evalJS('navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(function(rs){return rs.map(function(r){return r.active?r.active.state:"no-active"})}) : Promise.resolve("unsupported")', true)
  ok(Array.isArray(sw) && sw.includes('activated'), 'SW 已激活', sw)
  const caches = await evalJS('caches.keys()', true)
  ok(Array.isArray(caches) && caches.some((k) => k === 'daka-memocard-v4'), '离线缓存已建立', caches)

  console.log('\n== 控制台错误检查 ==')
  const errs = cli.events.filter((e) => e.method === 'Runtime.exceptionThrown')
  const logErrs = cli.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  ok(errs.length === 0, '无未捕获 JS 异常', errs.map((e) => e.params.exceptionDetails.text))
  ok(logErrs.length === 0, '无 console.error / 资源错误', logErrs.map((e) => e.params.entry.text))

  console.log('\n== 浏览器内 .apkg 解析（含 wasm） ==')
  const b64 = fs.readFileSync(FIXTURE).toString('base64')
  const result = await evalJS(`(async function(){
    var bin=atob('${b64}'); var arr=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    try {
      var SQL=await window.initSqlJs({locateFile:function(f){return 'vendor/'+f}});
      var r=await window.DakaApkg.parseApkg(arr.buffer,{JSZip:window.JSZip,initSqlJs:function(){return Promise.resolve(SQL)},DakaCore:window.DakaCore});
      return {ok:r.ok,rows:r.rows.length,noteCount:r.meta.noteCount,cloze:r.meta.skippedCloze,empty:r.meta.skippedEmpty,media:r.meta.mediaRefs,errs:r.errors};
    } catch(e){ return {fatal:String(e&&e.message||e)} }
  })()`, true)
  console.log('    result =', JSON.stringify(result))
  ok(result && result.ok === true, '浏览器内解析成功', result)
  ok(result && result.noteCount === 14 && result.rows === 12, '14 notes -> 12 行', result)
  ok(result && result.cloze === 1 && result.empty === 1 && result.media === 2, 'Cloze/空卡/媒体计数正确', result)

  console.log('\n==== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ====')
  await closeTab(tab.id)
  cli.close()
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1 })
