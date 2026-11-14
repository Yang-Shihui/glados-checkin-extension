// popup.js 渲染函数单测（DOM/chrome 桩执行；纯 Node 运行：node tests/popup.test.js）
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

const captured = {};
const elFactory = (id) => ({
  addEventListener() {},
  set innerHTML(v) { captured[id + ":html"] = v; },
  set textContent(v) { captured[id + ":text"] = v; },
  set className(v) { captured[id + ":cls"] = v; },
});
const stub = {
  document: { getElementById: (id) => elFactory(id) },
  chrome: {
    runtime: { sendMessage: async () => {}, getManifest: () => ({ version: "test" }) },
    storage: { local: { get: async () => ({}) } },
  },
};
const fn = new Function("document", "chrome", src + "\nreturn { esc, pillHtml, fullMsg, okRow, acctHtml, histHtml, renderBanner };");
const api = fn(stub.document, stub.chrome);
const today = api.esc(new Date().toLocaleDateString("sv-SE"));

let fail = 0;
const check = (name, html, mustHave, mustNotHave) => {
  for (const s of mustHave) if (!String(html).includes(s)) { console.log("FAIL", name, "缺少:", s); fail++; }
  for (const s of mustNotHave) if (String(html).includes(s)) { console.log("FAIL", name, "不应含:", s); fail++; }
  if (!fail) console.log("PASS", name);
};

// 1) 横幅-成功态（今天已签 + 完成时间）
api.renderBanner({ lastSuccessDate: today, history: [{ date: today, time: "14:04", status: "already" }] },
  [{ who: "a@b.c", status: "already", points: 0, balance: 308, streak: 3 }], false);
check("横幅-成功", captured["banner:cls"] + "|" + captured["banner:html"],
  ["banner ok", "今日全部已签", "14:04 完成"], ["今日 +"]);

// 2) 横幅-成功态带当日增量
api.renderBanner({ lastSuccessDate: today, history: [{ date: today, time: "14:04", status: "success" }] },
  [{ who: "a@b.c", status: "success", points: 7.2, balance: 315 }], false);
check("横幅-增量", captured["banner:html"], ["今日 +7.2"], []);

// 3) 横幅-运行态（1/2 + 实时动作）
api.renderBanner({ running: true, progress: "14:04 已完成 1/2 · 当前签到 45s" },
  [{ who: "a@b.c", status: "already" }, { who: "b@qq.com", status: "signing", detail: "等待验证结果 (45s)" }], true);
check("横幅-运行", captured["banner:cls"] + "|" + captured["banner:html"],
  ["banner run", "签到中 1/2", "等待验证结果 (45s)"], []);

// 4) 横幅-失败态（仅限今天的运行）/ 跨天不误报 / 未登录提示 / 空闲态
api.renderBanner({ lastResultsDate: today, lastSuccessDate: "2000-01-01" }, [{ who: "a", status: "failed" }], false);
check("横幅-失败(今日)", captured["banner:cls"] + "|" + captured["banner:html"],
  ["banner err", "今日未完成", "将自动重试"], []);
const yst = "2026-11-13";
api.renderBanner({ lastResultsDate: yst, lastSuccessDate: yst },
  [{ who: "a", status: "already" }], false);
check("横幅-跨天不误报", captured["banner:cls"] + "|" + captured["banner:html"],
  ["banner idle", "待签到"], ["今日未完成", "banner err"]);
api.renderBanner({ lastResultsDate: today, lastSuccessDate: "2000-01-01" },
  [{ who: "a", status: "not-logged-in" }], false);
check("横幅-未登录提示", captured["banner:html"], ["需要先在控制台登录"], ["将自动重试"]);
api.renderBanner({}, [], false);
check("横幅-空闲", captured["banner:cls"] + "|" + captured["banner:html"], ["banner idle", "待签到"], []);

// 5) 账号卡：已签 + 积分/连签（不出现英文样板）
check("账号卡-已签",
  api.acctHtml({ who: "user1@example.com", status: "already", points: 0, balance: 340, streak: 5 }),
  ["user1@example.com", "今日已签", "积分 340", "连签 5 天"],
  ["Today", "+0"]);

// 6) 账号卡：真签到 +7 → 绿色增量
check("账号卡-+7",
  api.acctHtml({ who: "x", status: "success", points: 7, balance: 315 }),
  ["签到成功", "+7", "积分 315"],
  []);

// 7) 账号卡：失败 → 截断原因 + tooltip 全文
const longMsg = "Error in invocation of scripting.executeScript(scripting.ScriptInjection injection): Unexpected property";
const fHtml = api.acctHtml({ who: "后续账号流程", status: "error", message: longMsg });
if (!fHtml.includes(">" + longMsg.slice(0, 46) + "…</span>")) { console.log("FAIL 失败原因未按 46 字截断"); fail++; }
else console.log("PASS 失败原因截断");
check("失败药丸", fHtml, ["pill err", 'title="' + longMsg], []);

// 8) 账号卡：进行中 → 转圈 + 详情
check("账号卡-签到中",
  api.acctHtml({ who: "当前账号", status: "signing", detail: "等待验证结果 (8s)" }),
  ["spin", "pill warn", "等待验证结果 (8s)"],
  []);

// 9) XSS 转义
const xss = api.acctHtml({ who: "<script>alert(1)</script>", status: "error", message: '<img onerror=1> x"y' });
if (xss.includes("<script>") || xss.includes("<img")) { console.log("FAIL XSS 未转义"); fail++; }
else console.log("PASS XSS 转义");

// 10) 历史行：日期缩写 + 增量
check("历史行",
  api.histHtml({ date: "2026-11-14", time: "14:04", who: "user1@example.com", status: "success", points: 7.2 }),
  ["11-14 14:04", "user1@example.com", "签到成功", "+7.2"],
  []);

// 11) 还原行：已还原药丸 + 切回详情；restored 计入成功
check("还原行",
  api.acctHtml({ who: "还原", status: "restored", detail: "已切回 user2@example.com", balance: 108, streak: 1 }),
  ["已还原", "已切回 user2@example.com", "积分 108"],
  []);
if (api.okRow({ status: "restored" })) console.log("PASS restored 计入成功");
else { console.log("FAIL restored 不计成功"); fail++; }

// 12) 还原失败：非致命——横幅保持绿色，行内黄色"未还原"
api.renderBanner({ lastResultsDate: today, lastSuccessDate: today },
  [{ who: "a@b.c", status: "already" }, { who: "会话还原", status: "restore-failed" }], false);
check("横幅-还原失败仍绿", captured["banner:cls"] + "|" + captured["banner:html"],
  ["banner ok", "今日全部已签"], ["banner err", "今日未完成"]);
check("还原失败行",
  api.acctHtml({ who: "会话还原", status: "restore-failed", message: "未能切回原账号，可在控制台手动切换" }),
  ["未还原", "pill warn", "未能切回原账号"],
  []);

// 13) 进行中状态清点：pending/signing/switching/busy 都带 spinner
for (const s of ["pending", "signing", "switching", "busy"]) {
  if (!api.pillHtml(s).includes("spin")) { console.log("FAIL", s, "缺 spinner"); fail++; }
}
console.log("PASS spinner 状态");

// 14) 历史还原行：切回对象可见
check("历史还原行",
  api.histHtml({ date: "2026-11-14", time: "15:00", who: "还原", status: "restored", message: "已切回 user2@example.com" }),
  ["15:00", "还原", "已还原", "已切回 user2@example.com"],
  []);

console.log(fail === 0 ? "=== popup 渲染单测全部通过 ===" : fail + " 处失败");
process.exit(fail === 0 ? 0 : 1);
