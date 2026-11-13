// 线上链接端到端验证：真实 Chrome 打开发布后的 https 地址（带分享码），
// 确认页面、依赖、SW、manifest 及浏览器内 .apkg 解析都正常。
const CDP = 'http://127.0.0.1:9222'
const URL = 'https://daka-memory-cards.app.workbuddy.host/?sharecode=KDDOWMTOVB'
import fs from 'node:fs'
const FIXTURE = 'C:/Users/yk/WorkBuddy/2026-10-10-09-04-10/打卡记忆卡-网页版/tests/fixture.apkg'

async function newTab() { return (await fetch(CDP + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json() }
async function closeTab(id) { try { await fetch(CDP + '/json/close/' + id) } catch (e) {} }
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); const pending = new Map(); let seq = 0; const events = []
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result) } else if (msg.method) events.push(msg) }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  return { ready, send, events, close: () => ws.close() }
}
async function main() {
  const tab = await newTab()
  const cli = cdp(tab.webSocketDebuggerUrl); await cli.ready
  await cli.send('Page.enable'); await cli.send('Runtime.enable'); await cli.send('Log.enable')
  // 纯净导航即可：data URI manifest 不依赖分享码 cookie，无竞态。
  // 若需模拟全新设备首访，请用 first_open.mjs（配全新 Chrome profile，不做清理）。
  await cli.send('Page.navigate', { url: URL })
  await new Promise((r) => setTimeout(r, 4500)) // 等页面 + SW + wasm

  let pass = 0, fail = 0
  const ok = (c, l, x) => { if (c) { pass++; console.log('  PASS ' + l) } else { fail++; console.log('  FAIL ' + l + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')) } }
  const ev = async (e, a = false) => { const r = await cli.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: a }); return r.exceptionDetails ? { __ex: r.exceptionDetails.text } : r.result.value }

  console.log('\n== 线上页面加载 ==')
  ok((await ev('document.title')) === '打卡记忆卡', '线上首页标题', await ev('document.title'))
  ok((await ev('location.protocol')) === 'https:', '走 https')
  ok((await ev('typeof window.DakaCore')) === 'object', 'core.js 线上加载')
  ok((await ev('typeof window.JSZip')) === 'function', 'JSZip 线上加载')
  ok((await ev('typeof window.initSqlJs')) === 'function', 'sql.js 线上加载')
  ok((await ev('typeof window.DakaApkg && typeof window.DakaApkg.parseApkg')) === 'function', 'apkg.js 线上加载')
  const missing = await ev('(window.__apkgDeps||[])')
  ok(Array.isArray(missing) && missing.length === 0, '无依赖加载失败', missing)

  console.log('\n== PWA 清单 / SW ==')
  const mf = await ev(`(function(){
    var h=document.querySelector('link[rel=manifest]'); if(!h) return {err:'no link'};
    var b=h.href.split(',')[1]; var j=JSON.parse(decodeURIComponent(escape(atob(b))));
    return {name:j.name,display:j.display,icons:j.icons.length,inline:h.href.indexOf('data:')===0};
  })()`, false)
  ok(mf && mf.name === '打卡记忆卡' && mf.display === 'standalone' && mf.icons === 3 && mf.inline, 'manifest 内联且正确', mf)
  const sws = await ev(`navigator.serviceWorker.getRegistrations().then(rs=>rs.length)`, true)
  ok(typeof sws === 'number' && sws >= 1, 'SW 已注册', sws)

  console.log('\n== 控制台错误 ==')
  const ex = cli.events.filter((e) => e.method === 'Runtime.exceptionThrown')
  const le = cli.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  ok(ex.length === 0, '无未捕获异常', ex.map((e) => e.params.exceptionDetails.text))
  ok(le.length === 0, '无资源/console 错误', le.map((e) => e.params.entry.text))

  console.log('\n== 浏览器内 .apkg 解析（线上真实 wasm）==')
  const b64 = fs.readFileSync(FIXTURE).toString('base64')
  const result = await ev(`(async function(){
    var bin=atob('${b64}'),arr=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    try{
      var SQL=await window.initSqlJs({locateFile:function(f){return 'vendor/'+f}});
      var r=await window.DakaApkg.parseApkg(arr.buffer,{JSZip:window.JSZip,initSqlJs:function(){return Promise.resolve(SQL)},DakaCore:window.DakaCore});
      return {ok:r.ok,rows:r.rows.length,noteCount:r.meta.noteCount};
    }catch(e){return {fatal:String(e&&e.message||e)}}
  })()`, true)
  ok(result && result.ok === true && result.noteCount === 14 && result.rows === 12, '线上浏览器内解析 .apkg 成功', result)

  console.log('\n==== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ====')
  await closeTab(tab.id); cli.close()
  if (fail > 0) process.exitCode = 1
}
main().catch((e) => { console.error('FATAL', e); process.exitCode = 1 })
