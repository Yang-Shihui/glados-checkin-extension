# 测试

纯 Node 脚本，无任何依赖：

```bash
node tests/popup.test.js      # popup 渲染函数单测（横幅/账号卡/历史行/XSS）
node tests/background.test.js # background 纯函数单测（积分/邮箱/uid 宽松探测）
```

原理：用 DOM/chrome 桩执行 popup.js 导出渲染函数断言输出；用正则从 background.js
截取 findPoints/findEmail/findUid 纯函数逐例验证。改动代码后请跑一遍再提交。
