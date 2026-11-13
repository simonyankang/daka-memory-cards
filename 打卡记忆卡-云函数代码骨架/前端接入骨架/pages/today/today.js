// pages/today —— 今日主页：打卡 + 待复习入口 + 卡片列表
// 只写逻辑骨架与数据流；WXML/WXSS 按团队 UI 自行套，字段名见本文末结构。
const api = require('../../api/cloud.js')

Page({
  data: {
    date: api.todayStr(),
    user: null,        // { streak, checkinDays }
    plans: [],         // [{ _id, title, enabled }]
    donePlanIds: [],   // 本次勾选项
    reviews: [],       // [{ _id, cardId, dueDate, card:{ front, back } }]
    checkedToday: false,
    loading: true,
    errMsg: '',
  },

  onLoad() { this.refresh() },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()) },

  async refresh() {
    this.setData({ loading: true, errMsg: '' })
    try {
      // 秒开：缓存先渲染，云端回来再覆盖
      const data = await api.getToday(this.data.date, {
        onCache: (c) => this.setData({ user: c.user, plans: c.plans || [], reviews: c.reviews || [] }),
      })
      this.setData({
        user: data.user,
        plans: data.plans || [],
        reviews: data.reviews || [],
        // 幂等由云函数保证；这里用「今天是否已有流水」的近似判断做 UI 态，
        // 真值可在云函数返回体补一个 checkedToday 字段（当前骨架未含，见接入说明）。
        checkedToday: !!(data.user && data.user.lastCheckin === this.data.date),
      })
    } catch (e) {
      this.setData({ errMsg: e.message })
    } finally {
      this.setData({ loading: false })
    }
  },

  onTogglePlan(e) {
    const id = e.currentTarget.dataset.id
    const set = new Set(this.data.donePlanIds)
    set.has(id) ? set.delete(id) : set.add(id)
    this.setData({ donePlanIds: Array.from(set) })
  },

  async onCheckin() {
    try {
      const r = await api.checkin(this.data.date, this.data.donePlanIds)
      wx.showToast({ title: r.alreadyCheckedIn ? '今天已打卡' : '打卡成功', icon: 'none' })
      this.refresh()
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' })
    }
  },

  onGoReview() {
    // 把待复习排程带过去，避免 review 页重复取；也可让 review 页自己 getToday
    wx.navigateTo({
      url: `/pages/review/review?date=${this.data.date}`,
    })
  },

  onGoImport() { wx.navigateTo({ url: '/pages/import/import' }) },
})

/*
最小 WXML 结构（示意，非完整样式）：
<view class="page">
  <view class="err" wx:if="{{errMsg}}">{{errMsg}}</view>
  <view class="stats" wx:if="{{user}}">
    连续 {{user.streak}} 天 · 累计 {{user.checkinDays}} 天
  </view>

  <view class="plans">
    <view wx:for="{{plans}}" wx:key="_id" data-id="{{item._id}}" bindtap="onTogglePlan">
      {{item.title}}
    </view>
  </view>
  <button bindtap="onCheckin">{{checkedToday ? '今日已打卡' : '打卡'}}</button>

  <button bindtap="onGoReview">开始复习（{{reviews.length}}）</button>
  <button bindtap="onGoImport">导入 Anki 卡片</button>
</view>
*/
