// 离线测试：验证 Service Worker 断网后仍能从缓存加载页面 + 全部 apkg 组件。
import fs from 'node:fs'
const CDP = 'http://127.0.0.1:9222'
const PAGE = 'http://127.0.0.1:8765/index.html'
const FIXTURE = 'C:/Users/yk/WorkBuddy/2026-10-10-09-04-10/打卡记忆卡-网页版/tests/fixture.apkg'

async function newTab() { return (await fetch(CDP + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json() }
async function closeTab(id) { try { await fetch(CDP + '/json/close/' + id) } catch (e) {} }
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); const pending = new Map(); let seq = 0
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result) } }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  return { ready, send, close: () => ws.close() }
}
async function main() {
  const tab = await newTab()
  const cli = cdp(tab.webSocketDebuggerUrl); await cli.ready
  await cli.send('Page.enable'); await cli.send('Runtime.enable'); await cli.send('Network.enable')
  // 先在线访问一次，确保 SW 控制该页面、缓存就绪
  await cli.send('Page.navigate', { url: PAGE })
  await new Promise((r) => setTimeout(r, 2500))
  // 模拟断网
  await cli.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  // 重新导航（此时应完全走 SW 缓存）
  await cli.send('Page.navigate', { url: PAGE })
  await new Promise((r) => setTimeout(r, 2000))

  let pass = 0, fail = 0
  const ok = (c, l, x) => { if (c) { pass++; console.log('  PASS ' + l) } else { fail++; console.log('  FAIL ' + l + (x !== undefined ? ' -> ' + JSON.stringify(x) : '')) } }
  const ev = async (expr, awaitP = false) => { const r = await cli.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP }); return r.exceptionDetails ? { __ex: r.exceptionDetails.text } : r.result.value }

  console.log('\n== 断网后从缓存加载 ==')
  ok((await ev('document.title')) === '打卡记忆卡', '页面从缓存打开')
  ok((await ev('typeof window.DakaCore')) === 'object', 'core.js 缓存命中')
  ok((await ev('typeof window.JSZip')) === 'function', 'JSZip 缓存命中')
  ok((await ev('typeof window.initSqlJs')) === 'function', 'sql.js 缓存命中')
  ok((await ev('typeof window.DakaApkg')) === 'object', 'apkg.js 缓存命中')

  console.log('\n== 断网后 wasm 加载 ==')
  const wasmOk = await ev(`fetch('vendor/sql-wasm.wasm').then(r=>r.arrayBuffer()).then(b=>b.byteLength).catch(e=>-1)`, true)
  ok(wasmOk === 659806, 'wasm 从缓存读取（字节数吻合）', wasmOk)

  console.log('\n== 断网后 .apkg 解析 ==')
  const b64 = fs.readFileSync(FIXTURE).toString('base64')
  const result = await ev(`(async function(){
    var bin=atob('${b64}'),arr=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    try{
      var SQL=await window.initSqlJs({locateFile:function(f){return 'vendor/'+f}});
      var r=await window.DakaApkg.parseApkg(arr.buffer,{JSZip:window.JSZip,initSqlJs:function(){return Promise.resolve(SQL)},DakaCore:window.DakaCore});
      return {ok:r.ok,rows:r.rows.length};
    }catch(e){return {fatal:String(e&&e.message||e)}}
  })()`, true)
  ok(result && result.ok === true && result.rows === 12, '断网下仍能解析 .apkg', result)

  console.log('\n==== 结果：PASS ' + pass + ' / FAIL ' + fail + ' ====')
  await closeTab(tab.id); cli.close()
  if (fail > 0) process.exitCode = 1
}
main().catch((e) => { console.error('FATAL', e); process.exitCode = 1 })
