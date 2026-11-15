# 测试

纯 Node 脚本，无任何依赖：

```bash
node tests/popup.test.js         # popup 渲染函数单测（横幅/账号卡/历史行/XSS）
node tests/background.test.js    # background 纯函数单测（积分/邮箱/uid 宽松探测）
node tests/integration.test.js   # 端到端集成测试（模拟 chrome.* 与 GLaDOS 页面，跑完整签到状态机，约 1 分钟）
```

原理：用 DOM/chrome 桩执行 popup.js 导出渲染函数断言输出；用正则从 background.js
截取 findPoints/findEmail/findUid 纯函数逐例验证；集成测试模拟完整的浏览器与
GLaDOS 服务端行为，对真实 background.js 跑五种场景（新鲜日全流程/会话失效/
Turnstile 拒绝/人工点击验证/看门狗清理）。改动代码后请跑一遍再提交。
