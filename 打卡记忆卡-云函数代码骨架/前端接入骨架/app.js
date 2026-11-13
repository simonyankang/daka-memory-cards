// app.js —— 云开发初始化（全链路唯一入口）
// 对应《接入说明》前置条件：wx.cloud.init 必须先于任何 callFunction 调用。
App({
  globalData: {},

  onLaunch() {
    // wx.cloud 由基础库注入；低于 2.2.3 的版本没有该对象，避免直接报错给出可操作提示。
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请在开发者工具「详情 → 本地设置」把调试基础库调到 2.2.3 以上，并确保已开通云开发。',
        showCancel: false,
      })
      return
    }

    wx.cloud.init({
      // DYNAMIC_CURRENT_ENV = 当前打开项目所绑定的云环境，无需硬编码 env id。
      // 若使用多环境或低版本基础库不支持该常量，改成你的固定环境 ID：env: 'your-env-id'
      env: wx.cloud.DYNAMIC_CURRENT_ENV,
      traceUser: true,
    })
  },
})
