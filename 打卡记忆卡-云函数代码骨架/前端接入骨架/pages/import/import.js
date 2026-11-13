// pages/import —— 导入页：一期纯文字 CSV（选文件 / 粘贴两种入口）
const api = require('../../api/cloud.js')

Page({
  data: {
    mode: 'file',      // file | paste
    pasted: '',
    fileName: '',
    busy: false,
    result: null,
    errMsg: '',
  },

  onMode(e) { this.setData({ mode: e.currentTarget.dataset.mode, result: null, errMsg: '' }) },
  onPaste(e) { this.setData({ pasted: e.detail.value }) },

  async onChooseFile() {
    try {
      const res = await new Promise((resolve, reject) => {
        wx.chooseMessageFile({
          count: 1, type: 'file', extension: ['csv', 'txt'],
          success: resolve, fail: reject,
        })
      })
      const file = res.tempFiles[0]
      this.setData({ fileName: file.name })
      await this.doImport(await api.readCsvFile(file.path))
    } catch (e) {
      this.setData({ errMsg: e.errMsg || e.message || '选择文件失败' })
    }
  },

  async onImportPaste() {
    if (!this.data.pasted.trim()) {
      this.setData({ errMsg: '请先粘贴 CSV 内容' }); return
    }
    await this.doImport(this.data.pasted)
  },

  async doImport(csv) {
    this.setData({ busy: true, errMsg: '', result: null })
    try {
      const r = await api.importAnkiCsv(csv)
      this.setData({
        result: {
          导入: r.inserted,
          文件内去重: r.dupInFile,
          库中已存在: r.dupInDb,
          失败: r.failed,
          预估写调用: r.approxWriteCalls,
        },
      })
      wx.showToast({ title: `导入 ${r.inserted} 张`, icon: 'none' })
    } catch (e) {
      // 413 超行数 / 400 格式错都带 detail，展示首条错误
      const hint = e.detail && e.detail.errors && e.detail.errors[0]
      this.setData({ errMsg: (e.message || '导入失败') + (hint ? `：${hint}` : '') })
    } finally {
      this.setData({ busy: false })
    }
  },

  onGoToday() { wx.navigateBack() },
})

/*
最小 WXML 结构（示意）：
<view class="page">
  <view class="tabs">
    <button data-mode="file" bindtap="onMode">选文件</button>
    <button data-mode="paste" bindtap="onMode">粘贴</button>
  </view>

  <block wx:if="{{mode==='file'}}">
    <button bindtap="onChooseFile" disabled="{{busy}}">选择 CSV 文件</button>
    <view wx:if="{{fileName}}">已选：{{fileName}}</view>
  </block>
  <block wx:else>
    <textarea placeholder="首行：front,back" bindinput="onPaste" />
    <button bindtap="onImportPaste" disabled="{{busy}}">导入</button>
  </block>

  <view class="err" wx:if="{{errMsg}}">{{errMsg}}</view>
  <view class="result" wx:if="{{result}}">
    <view wx:for="{{result}}" wx:key="*this">{{item}}: {{result[item]}}</view>
  </view>
  <view class="tip">一期仅纯文字；格式见 CSV导入格式规范.md</view>
</view>
*/
