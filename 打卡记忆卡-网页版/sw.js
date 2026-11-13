/*
 * sw.js — 离线缓存。让 PWA 断网也能打开、复习、解析已缓存的 apkg 组件。
 * 策略：cache-first（静态工具，内容不常变，优先离线可用）；
 * 版本化 CACHE，activate 清理旧缓存；安装时 precache 全部核心资源。
 * 注意：本应用数据存浏览器本地存储，SW 只缓存程序文件，不碰数据。
 */
var CACHE = 'daka-memocard-v4'
var CORE = [
  './', './index.html', './core.js', './apkg.js',
  './vendor/jszip.min.js', './vendor/sql-wasm.js', './vendor/sql-wasm.wasm',
  './icon.svg', './icon-192.png', './icon-512.png'
]

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 单个资源失败不拖垮整次安装（例如某图标缺失仍可离线用主功能）。
      return Promise.all(CORE.map(function (url) {
        return c.add(url).catch(function () { return null })
      }))
    }).then(function () { return self.skipWaiting() })
  )
})

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k !== CACHE ? caches.delete(k) : null
      }))
    }).then(function () { return self.clients.claim() })
  )
})

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return
  var url = new URL(e.request.url)
  if (url.origin !== self.location.origin) return // 跨域交给浏览器，不拦截

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit
      return fetch(e.request).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone()
          caches.open(CACHE).then(function (c) { c.put(e.request, copy) })
        }
        return res
      }).catch(function () {
        // 离线且未命中：导航请求回退到首页，其余返回 503。
        if (e.request.mode === 'navigate') return caches.match('./index.html')
        return new Response('offline', { status: 503, statusText: 'offline' })
      })
    })
  )
})
