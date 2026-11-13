// pages/review —— 复习页：翻卡 + 四档评分 + 批量提交
// 关键：一次复习批次攒在内存，翻完统一 submitReview（一次云函数调用批量更新，省调用）。
const api = require('../../api/cloud.js')

// 四档按钮 → rating（映射 q 值在云函数，见 submitReview 常量）
const BUTTONS = [
  { key: 'again', label: '忘了' },
  { key: 'hard', label: '吃力' },
  { key: 'good', label: '记住' },
  { key: 'easy', label: '轻松' },
]

Page({
  data: {
    date: '',
    queue: [],        // 待复习 [{ _id, cardId, card:{front,back} }]
    index: 0,
    showBack: false,
    results: [],      // [{ cardId, rating }]
    buttons: BUTTONS,
    submitting: false,
    done: false,
    summary: null,
  },

  onLoad(q) {
    const date = q.date || api.todayStr()
    this.setData({ date })
    this.load(date)
  },

  async load(date) {
    try {
      const data = await api.getToday(date)
      // 只取有正文的排程（卡片被删的跳过）；可选限制单批数量，与 submitReview MAX_ITEMS 对齐
      const queue = (data.reviews || []).filter((r) => r.card).slice(0, 100)
      this.setData({ queue, index: 0, done: queue.length === 0 })
      if (queue.length === 0) wx.showToast({ title: '今天没有待复习卡片', icon: 'none' })
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' })
    }
  },

  onShowAnswer() { this.setData({ showBack: true }) },

  onRate(e) {
    const rating = e.currentTarget.dataset.rating
    const cur = this.data.queue[this.data.index]
    if (!cur) return
    const results = this.data.results.concat([{ cardId: cur.cardId, rating }])
    const next = this.data.index + 1
    if (next >= this.data.queue.length) {
      this.setData({ results, index: next })
      this.flush(results) // 翻完最后一张，统一提交
    } else {
      this.setData({ results, index: next, showBack: false })
    }
  },

  async flush(results) {
    this.setData({ submitting: true })
    try {
      const r = await api.submitReview(results, this.data.date)
      this.setData({
        done: true,
        submitting: false,
        summary: { 提交: r.submitted, 更新: r.updated, 无排程跳过: r.skippedNoSchedule, 失败: r.failed },
      })
    } catch (e) {
      this.setData({ submitting: false, errMsg: e.message })
      // 提交失败时 results 仍留在内存，可加「重试」按钮重调 flush（此处骨架略）
    }
  },
})

/*
最小 WXML 结构（示意）：
<view class="page" wx:if="{{!done}}">
  <block wx:if="{{index < queue.length}}">
    <view class="card" bindtap="onShowAnswer">
      <view class="front">{{queue[index].card.front}}</view>
      <view class="back" wx:if="{{showBack}}">{{queue[index].card.back}}</view>
      <view class="hint" wx:else>点击查看答案</view>
    </view>
    <view class="buttons" wx:if="{{showBack}}">
      <button wx:for="{{buttons}}" wx:key="key" data-rating="{{item.key}}" bindtap="onRate">
        {{item.label}}
      </button>
    </view>
    <view class="progress">{{index+1}} / {{queue.length}}</view>
  </block>
</view>
<view class="summary" wx:if="{{done}}">
  复习完成：{{summary.更新}} 张已更新排程
</view>
*/
