// 模拟全新设备首次打开线上链接：清空站点数据 + 注销 SW + 删缓存后重访，
// 验证 manifest 通过动态注入拿到 200（发布平台分享码 cookie 已落盘），无 403。
const CDP = 'http://127.0.0.1:9222'
const URL = 'https://daka-memory-cards.app.workbuddy.host/?sharecode=KDDOWMTOVB'
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
await c.send('Storage.clearDataForOrigin', { origin: 'https://daka-memory-cards.app.workbuddy.host', storageTypes: 'all' })
const clean = await c.send('Runtime.evaluate', {
  expression: 'caches.keys().then(k=>Promise.all(k.map(x=>caches.delete(x)))).then(()=>navigator.serviceWorker.getRegistrations()).then(rs=>Promise.all(rs.map(r=>r.unregister()))).then(()=>"cleared")',
  awaitPromise: true, returnByValue: true
})
console.log('cleanup:', clean.result.value)
await c.send('Page.navigate', { url: URL })
await new Promise(r => setTimeout(r, 5500))
const errs = c.ev.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
const net4 = c.ev.filter(e => e.method === 'Network.responseReceived').map(e => e.params).filter(p => p.response.status >= 400)
const mfNet = c.ev.filter(e => e.method === 'Network.responseReceived').map(e => e.params).filter(p => /manifest/.test(p.response.url)).map(p => p.response.status + ' ' + p.response.url)
const reg = await c.send('Runtime.evaluate', { expression: 'navigator.serviceWorker.getRegistrations().then(r=>r.length)', awaitPromise: true, returnByValue: true })
const link = await c.send('Runtime.evaluate', {
  expression: `(function(){var h=document.querySelector('link[rel=manifest]');if(!h)return{inline:false,valid:false};var b=h.href.split(',')[1];try{var j=JSON.parse(decodeURIComponent(escape(atob(b))));return{inline:h.href.indexOf('data:')===0,valid:j.display==='standalone'&&j.icons.length===3}}catch(e){return{inline:false,valid:false}}})()`,
  returnByValue: true
})
console.log('manifest net reqs :', JSON.stringify(mfNet), '(应为空 = data URI 零请求)')
console.log('HTTP >=400        :', JSON.stringify(net4.map(p => p.response.status + ' ' + p.response.url)))
console.log('log errors        :', JSON.stringify(errs.map(e => e.params.entry.text)))
console.log('SW registrations  :', reg.result.value, ' manifest link :', JSON.stringify(link.result.value))
const good = mfNet.length === 0 && net4.length === 0 && errs.length === 0 && reg.result.value >= 1 && link.result.value.inline && link.result.value.valid
console.log(good ? '\nRESULT: PASS (首次访问 manifest 内联零请求，无 403，SW 就绪，PWA 可安装)' : '\nRESULT: CHECK FAILED')
await closeTab(tab.id); c.close()
if (!good) process.exitCode = 1
