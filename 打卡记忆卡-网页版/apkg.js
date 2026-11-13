/*
 * apkg.js — .apkg 纯文字导入适配层（二期）。
 *
 * 职责单一：把 Anki 的 .apkg（ZIP + SQLite）解成与 CSV 导入同构的 rows，
 * 交给 core.js 已验证的 importRows 走同一套去重/入库/进度保护。
 * 本文件是唯一依赖 JSZip + sql.js 的地方，core.js 保持零依赖纯逻辑。
 *
 * 只提纯文字：读 notes.flds 按 0x1F 拆字段，取首字段为正面、其余合并为背面；
 * HTML 交给 core.stripMarkup 清洗，img/[sound] 引用剥离并计数，不搬媒体本体。
 * Cloze（{{c1::}}）跳过并计数。新版 Zstd 压缩的 collection.anki21b 无法用
 * sql.js 直接读，识别后走友好降级，不伪称可读。
 *
 * 依赖注入：浏览器里用全局 JSZip / initSqlJs；Node 自检可传入 { JSZip, initSqlJs }。
 * UMD 风格，与 core.js 一致。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.DakaApkg = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  var DB_ENTRIES = ['collection.anki2', 'collection.anki21', 'collection.anki21b']
  var ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  var SEP = '\x1f'

  function isZstd(buf) {
    return buf && buf.length >= 4 && buf[0] === ZSTD_MAGIC[0] && buf[1] === ZSTD_MAGIC[1] &&
      buf[2] === ZSTD_MAGIC[2] && buf[3] === ZSTD_MAGIC[3]
  }

  // 从 col.models 的 JSON 里挑出「主笔记类型」的正/反面字段名。
  // Anki 的 flds 顺序由 model 决定，但绝大多数 Basic 卡首字段=正面、其余=背面；
  // 这里不强依赖 model 解析成功，取不到就退回默认（首字段/其余合并）。
  function fieldSeparatorHint(modelsJson) {
    try {
      var models = JSON.parse(modelsJson || '{}')
      var first = models[Object.keys(models)[0]]
      if (first && Array.isArray(first.flds)) {
        return first.flds.map(function (f) { return f && f.name }).filter(Boolean)
      }
    } catch (e) { /* 解析失败按默认处理 */ }
    return null
  }

  /**
   * 解析 .apkg。
   * @param {ArrayBuffer|Buffer|Uint8Array} fileBuffer 文件字节
   * @param {object} deps { JSZip, initSqlJs, DakaCore } —— 浏览器可省略（用全局/自身加载）
   * @returns {Promise<{ok, rows, meta, errors}>}
   *   rows: 与 core.mapRows 输出同构，可直接喂 core.importRows
   */
  async function parseApkg(fileBuffer, deps) {
    deps = deps || {}
    var JSZipLib = deps.JSZip || (typeof JSZip !== 'undefined' ? JSZip : null)
    var initSql = deps.initSqlJs || (typeof initSqlJs !== 'undefined' ? initSqlJs : null)
    var Core = deps.DakaCore || (typeof DakaCore !== 'undefined' ? DakaCore : null)

    if (!JSZipLib) return { ok: false, rows: [], meta: {}, errors: ['缺少 JSZip 依赖'] }
    if (!initSql) return { ok: false, rows: [], meta: {}, errors: ['缺少 sql.js 依赖'] }
    if (!Core || !Core.stripMarkup) return { ok: false, rows: [], meta: {}, errors: ['缺少 core.js（需在 apkg.js 之前引入）'] }

    var meta = { dbEntry: '', noteCount: 0, skippedEmpty: 0, skippedCloze: 0, mediaRefs: 0, models: null, warnings: [] }
    var errors = []

    var zip
    try {
      zip = await JSZipLib.loadAsync(fileBuffer)
    } catch (e) {
      return { ok: false, rows: [], meta: meta, errors: ['不是有效的 .apkg（ZIP 解包失败）：' + (e && e.message ? e.message : e)] }
    }

    var entryName = DB_ENTRIES.find(function (n) { return zip.file(n) })
    if (!entryName) {
      return { ok: false, rows: [], meta: meta, errors: ['包内找不到 collection.anki2 / anki21 / anki21b，可能不是 Anki 导出的 .apkg'] }
    }
    meta.dbEntry = entryName

    if (entryName === 'collection.anki21b') {
      var rawHead = await zip.file(entryName).async('uint8array')
      if (isZstd(rawHead)) {
        return {
          ok: false, rows: [], meta: meta,
          errors: ['检测到新版 Anki 的 collection.anki21b（Zstd 压缩 SQLite），当前纯前端版本读不了。请在 Anki 里「导出 → 旧版/兼容格式」或改用 CSV 导入。']
        }
      }
      // 名字像 anki21b 但不是 Zstd：仍尝试当普通 SQLite 读，读不出来再报错。
      meta.warnings.push('anki21b 条目非 Zstd 魔数，尝试按普通 SQLite 读取')
    }

    var dbBytes
    try {
      dbBytes = await zip.file(entryName).async('uint8array')
    } catch (e) {
      return { ok: false, rows: [], meta: meta, errors: ['读取数据库条目失败：' + (e && e.message ? e.message : e)] }
    }

    var SQL
    try {
      SQL = await initSql(deps.sqlJsConfig || undefined)
    } catch (e) {
      return { ok: false, rows: [], meta: meta, errors: ['sql.js(wasm) 初始化失败：' + (e && e.message ? e.message : e)] }
    }

    var db
    try {
      db = new SQL.Database(dbBytes)
    } catch (e) {
      return { ok: false, rows: [], meta: meta, errors: ['SQLite 打开失败（可能是压缩或加密的库）：' + (e && e.message ? e.message : e)] }
    }

    try {
      // 读模型字段顺序（仅用于提示，不影响默认取法）
      var modelRes = db.exec('SELECT models FROM col LIMIT 1')
      if (modelRes.length && modelRes[0].values.length) {
        meta.models = fieldSeparatorHint(modelRes[0].values[0][0])
      }

      var res = db.exec('SELECT guid, flds, tags, mid FROM notes')
      if (!res.length || !res[0].values.length) {
        return { ok: true, rows: [], meta: meta, errors: ['包内 notes 表为空，没有可导入的卡片'] }
      }
      var cols = res[0].columns
      var iGuid = cols.indexOf('guid'), iFlds = cols.indexOf('flds'), iTags = cols.indexOf('tags'), iMid = cols.indexOf('mid')
      var values = res[0].values
      meta.noteCount = values.length

      var rows = []
      for (var i = 0; i < values.length; i += 1) {
        var v = values[i]
        var guid = String(v[iGuid] == null ? '' : v[iGuid]).trim()
        var fldsRaw = String(v[iFlds] == null ? '' : v[iFlds])
        var tagsRaw = String(v[iTags] == null ? '' : v[iTags])
        var parts = fldsRaw.split(SEP)

        if (Core.hasCloze(fldsRaw)) { meta.skippedCloze += 1; continue }

        var fFront = Core.stripMarkup(parts[0] || '')
        var fBack = Core.stripMarkup(parts.slice(1).join('\n'))
        meta.mediaRefs += fFront.mediaRefs.length + fBack.mediaRefs.length

        var front = fFront.text.trim()
        var back = fBack.text.trim()
        if (!front && !back) { meta.skippedEmpty += 1; continue }
        if (!front) { // 只有背面：把背面当正面，避免丢卡（如反面卡/字段颠倒）
          front = back; back = ''
        }
        if (front.length > 2000 || back.length > 2000) {
          meta.warnings.push('第 ' + (i + 1) + ' 行字段超过 2000 字，已截断')
          front = front.slice(0, 2000); back = back.slice(0, 2000)
        }

        var tags = tagsRaw.trim().split(/\s+/).filter(Boolean)
        rows.push({
          front: front,
          back: back,
          tags: tags,
          deckId: 'mid:' + (v[iMid] == null ? '' : v[iMid]), // 卡组用 model id 占位，纯文字场景够用
          ankiGuid: guid ? 'a:' + guid : 'h:' + Core.stableHash(front + SEP + back)
        })
      }

      if (meta.skippedCloze) meta.warnings.push('跳过 Cloze 填空卡 ' + meta.skippedCloze + ' 张（纯文字版不支持）')
      if (meta.skippedEmpty) meta.warnings.push('跳过正反面都为空 ' + meta.skippedEmpty + ' 张')
      if (meta.mediaRefs) meta.warnings.push('剥离图片/音频引用 ' + meta.mediaRefs + ' 处（纯文字版不搬媒体）')
      return { ok: true, rows: rows, meta: meta, errors: [] }
    } catch (e) {
      return { ok: false, rows: [], meta: meta, errors: ['解析 notes 表失败：' + (e && e.message ? e.message : e)] }
    } finally {
      try { db.close() } catch (e) { /* ignore */ }
    }
  }

  return { parseApkg: parseApkg, DB_ENTRIES: DB_ENTRIES }
})
