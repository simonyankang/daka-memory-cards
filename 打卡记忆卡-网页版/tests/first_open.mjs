// 决定性验证：全新 Chrome profile（零 cookie/零缓存）第一次就打开带 sharecode 的
// 线上链接，完全模拟用户手机首次访问。检查所有子资源 200、manifest 内联零请求、
// SW 就绪、无 403、浏览器内 .apkg 可解析。不做任何清理动作。
import fs from 'node:fs'
const CDP = 'http://127.0.0.1:9222'
const URL = 'https://daka-memory-cards.app.workbuddy.host/?sharecode=KDDOWMTOVB'
const FIXTURE = 'C:/Users/yk/WorkBuddy/2026-10-10-09-04-10/打卡记忆卡-网页版/tests/fixture.apkg'
async function newTab() { return (await fetch(CDP + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json() }
async function closeTab(id) { try { await fetch(CDP + '/json/close/' + id) } catch (e) {} }
function cdp(ws) {
  const w = new WebSocket(ws); const p = new Map(); let n = 0; const ev = []
  const ready = new Promise((r, j) => { w.onopen = r; w.onerror = j })
  w.onmessage = m => { const o = JSON.parse(m.data); if (o.id && p.has(o.id)) { const x = p.get(o.id); p.delete(o.id); o.error ? x.j(new Error(JSON.stringify(o.error))) : x.r(o.result) } else if (o.method) ev.push(o) }
  const send = (method, params = {}) => new Promise((r, j) => { const id = ++n; p.set(id, { r, j }); w.send(JSON.stringify({ id, method, params })) })
  return { ready, send, ev, close: () => w.close() }
}
const tab = await newTab(); const c = cdp(tab.webSocketDebuggerUrl); await c.ready
await c.send('Network.enable'); await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable')
await c.send('Page.navigate', { url: URL })
await new Promise(r => setTimeout(r, 5500))

let pass = 0, fail = 0
const ok = (cond, label, extra) => { if (cond) { pass++; console.log('  PASS ' + label) } else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')) } }
const ev = async (e, a = false) => { const r = await c.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: a }); return r.exceptionDetails ? { __ex: r.exceptionDetails.text } : r.result.value }

console.log('\n== 首次打开：子资源状态 ==')
const net4 = c.ev.filter(e => e.method === 'Network.responseReceived').map(e => e.params).filter(p => p.response.status >= 400).map(p => p.response.status + ' ' + p.response.url)
ok(net4.length === 0, '零 HTTP 4xx/5xx（尤其无 403）', net4)
const errs = c.ev.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error').map(e => e.params.entry.text)
ok(errs.length === 0, '零 console/资源错误', errs)

console.log('\n== 页面 / 依赖 ==')
ok((await ev('document.title')) === '打卡记忆卡', '首页正常')
ok((await ev('location.protocol')) === 'https:', 'https')
ok((await ev('typeof window.JSZip')) === 'function', 'JSZip')
ok((await ev('typeof window.initSqlJs')) === 'function', 'sql.js')
ok((await ev('typeof window.DakaApkg && typeof window.DakaApkg.parseApkg')) === 'function', 'apkg.js')
ok(((await ev('(window.__apkgDeps||[])')).length) === 0, '无依赖加载失败')

console.log('\n== PWA / SW ==')
const mf = await ev(`(function(){var h=document.querySelector('link[rel=manifest]');if(!h)return{};var b=h.href.split(',')[1];try{var j=JSON.parse(decodeURIComponent(escape(atob(b))));return{inline:h.href.indexOf('data:')===0,name:j.name,display:j.display,icons:j.icons.length}}catch(e){return{err:String(e)}}})()`)
ok(mf.inline && mf.name === '打卡记忆卡' && mf.display === 'standalone' && mf.icons === 3, 'manifest 内联 data URI 且正确', mf)
const mfNet = c.ev.filter(e => e.method === 'Network.responseReceived').map(e => e.params)
  .filter(p => /manifest/.test(p.response.url) && !p.response.url.startsWith('data:'))
ok(mfNet.length === 0, 'manifest 走 data URI，零 HTTP 网络请求（彻底规避 403）', mfNet.map(p => p.response.status + ' ' + p.response.url))
const sw = await ev('navigator.serviceWorker.getRegistrations().then(r=>r.length)', true)
ok(sw >= 1, 'SW 注册成功', sw)

console.log('\n== 浏览器内 .apkg 解析 ==')
const b64 = fs.readFileSync(FIXTURE).toString('base64')
const res = await ev(`(async function(){var bin=atob('${b64}'),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);try{var S=await window.initSqlJs({locateFile:function(f){return 'vendor/'+f}});var r=await window.DakaApkg.parseApkg(a.buffer,{JSZip:window.JSZip,initSqlJs:function(){return Promise.resolve(S)},DakaCore:window.DakaCore});return{ok:r.ok,rows:r.rows.length}}catch(e){return{fatal:String(e&&e.message||e)}}})()`, true)
ok(res && res.ok && res.rows === 12, '线上解析 .apkg 成功（真实 wasm）', res)

console.log('\n==== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ====')
await closeTab(tab.id); c.close()
if (fail > 0) process.exitCode = 1
