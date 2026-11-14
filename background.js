// GLaDOS 多账号自动签到（Chrome MV3 service worker）
// 架构说明：
//   - 签到运行 = 状态机（runState 持久化在 storage，每步镜像；心跳供看门狗判活）
//   - 看门狗闹钟每分钟检查心跳：Service Worker 被浏览器回收导致运行中断时，
//     90 秒后自动清理现场、标记失败原因，不会卡死
//   - 多账号：利用 GLaDOS 官方多账号系统（/api/user/accounts 列表 + switch 切换）
const CHECKIN_URL = "https://glados.rocks/console/checkin";
const ALARM = "glados-probe";      // 每天签到窗口（DAILY_WINDOWS 内随机时刻）的签到闹钟
const WATCHDOG = "glados-watchdog"; // 每分钟的运行看门狗
const RETRY = "glados-retry";      // 失败后 30 分钟的一次性重试
const COOKIE_DOMAIN = "glados.rocks";

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ running: false, runState: null, progress: "就绪（扩展已重载）" });
  scheduleNext();
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(async () => {
  scheduleNext();
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  await sleep(10000); // 等 Chrome 启动后网络就绪
  await maybeRun();   // 当天未签则立即补签
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === ALARM) { await maybeRun(); scheduleNext(); }
  if (a.name === WATCHDOG) await watchdog();
  if (a.name === RETRY) await maybeRun();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.cmd === "run") {
    startRun("manual");
    sendResponse({ ok: true, started: true });
    return false;
  }
  if (msg && msg.cmd === "state") {
    chrome.storage.local
      .get(["lastResults", "history", "lastSuccessDate", "progress", "runState", "running"])
      .then(sendResponse);
    return true;
  }
});

// 点系统通知直接打开控制台：失败 → 去处理；成功 → 看积分
chrome.notifications.onClicked.addListener(() => {
  try { chrome.tabs.create({ url: "https://glados.rocks/console" }); } catch (e) {}
});

// 每天两个签到窗口，实际时刻在窗口内随机——固定整点长期看太机械
const DAILY_WINDOWS = [
  [12 * 60 + 15, 12 * 60 + 45], // 12:15 ~ 12:45
  [19 * 60, 19 * 60 + 20],      // 19:00 ~ 19:20
];

function scheduleNext() {
  const now = new Date();
  let next = Infinity;
  for (const [lo, hi] of DAILY_WINDOWS) {
    for (let off = 0; off <= 1; off++) {
      const d = new Date(now);
      d.setDate(d.getDate() + off);
      const mins = lo + Math.floor(Math.random() * (hi - lo + 1));
      d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
      if (d.getTime() > now.getTime() + 5000 && d.getTime() < next) next = d.getTime();
    }
  }
  if (next !== Infinity) chrome.alarms.create(ALARM, { when: next });
}

function todayStr() {
  return new Date().toLocaleDateString("sv-SE");
}

async function maybeRun() {
  const { enabled = true, lastSuccessDate = "" } = await chrome.storage.local.get(["enabled", "lastSuccessDate"]);
  if (!enabled) return;
  const h = new Date().getHours();
  if (h < 9 || h >= 23) return;
  if (lastSuccessDate === todayStr()) {
    await setBadge("✓", "#1a7f37");
    return;
  }
  await startRun("auto");
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 失败自动重试：当天最多 3 次（反复自动尝试太多反而显机械），间隔 25~40 分钟随机
async function scheduleRetry() {
  const today = todayStr();
  const { retryDate = "", retryCount = 0 } = await chrome.storage.local.get(["retryDate", "retryCount"]);
  if (retryDate !== today) {
    await chrome.storage.local.set({ retryDate: today, retryCount: 1 });
  } else if (retryCount >= 3) {
    return;
  } else {
    await chrome.storage.local.set({ retryCount: retryCount + 1 });
  }
  chrome.alarms.create(RETRY, { when: Date.now() + (25 + Math.floor(Math.random() * 16)) * 60000 });
}

async function setProgress(msg) {
  await chrome.storage.local.set({ progress: `${new Date().toTimeString().slice(0, 5)} ${msg}` });
}

// 把运行状态镜像到 storage：popup 据此实时渲染步骤条，看门狗据此判断心跳
async function mirror(runState) {
  runState.heartbeat = Date.now();
  await chrome.storage.local.set({ runState });
}

// ===== 看门狗：SW 被回收导致运行中断时清理现场 =====
async function watchdog() {
  const { runState } = await chrome.storage.local.get("runState");
  if (!runState || !runState.active) return;
  if (Date.now() - (runState.heartbeat || 0) < 90000) return; // 心跳正常
  // 心跳停止 → 运行已死：标记中断行、还原 cookie 现场、关标签页、记历史
  runState.active = false;
  const orphans = [];
  for (const a of runState.accounts || []) {
    if (["pending", "signing", "switching"].includes(a.status)) {
      a.status = "failed";
      a.detail = "运行被浏览器中断";
      orphans.push(a);
    }
  }
  if (runState.snapshot && runState.snapshot.length) {
    try { await restoreCookies(runState.snapshot); } catch (e) {}
  }
  const { history = [] } = await chrome.storage.local.get("history");
  const entry = {
    date: todayStr(),
    time: new Date().toTimeString().slice(0, 5),
    trigger: runState.trigger,
    who: "看门狗",
    status: "error",
    message: "运行中断（SW 被回收）" + (orphans.length ? `，${orphans.length} 个账号未完成` : ""),
    points: "",
  };
  await chrome.storage.local.set({
    runState,
    running: false,
    runningSince: 0,
    lastResultsDate: todayStr(),
    history: [entry, ...history].slice(0, 60),
    progress: "运行被浏览器中断，已重置——下个时段自动重试",
  });
  await setBadge("✗", "#b91c1c");
  // 中断属瞬态故障：自动重试（当天有上限）
  await scheduleRetry();
  if (runState.tabId) { try { await chrome.tabs.remove(runState.tabId); } catch (e) {} }
}

// ===== 运行入口 =====
let startGuard = false; // 同一 SW 上下文内的防重入（storage 运行锁负责跨 SW 重启的场景）

async function startRun(trigger) {
  if (startGuard) return;
  startGuard = true;
  try {
    await startRunInner(trigger);
  } finally {
    startGuard = false;
  }
}

async function startRunInner(trigger) {
  const { running = false, runningSince = 0 } = await chrome.storage.local.get(["running", "runningSince"]);
  if (running && Date.now() - runningSince < 300000) return; // 5 分钟内的运行锁
  const runState = {
    active: true,
    trigger,
    tabId: null,
    startedAt: Date.now(),
    heartbeat: Date.now(),
    accounts: [], // [{who, status: pending|signing|switching|success|already|failed, detail}]
  };
  await chrome.storage.local.set({ running: true, runningSince: Date.now(), runState, lastResults: [], progress: "启动…" });
  let finalResults = [];
  try {
    finalResults = await runMultiCheckin(trigger, runState);
  } catch (e) {
    finalResults = [{ who: "运行", status: "error", message: String((e && e.message) || e) }];
    try { await finalizeRun(finalResults, runState, false); } catch (e2) {}
  } finally {
    runState.active = false;
    runState.heartbeat = Date.now();
    await chrome.storage.local.set({ runState, running: false, runningSince: 0 });
    if (runState.tabId) { try { await chrome.tabs.remove(runState.tabId); } catch (e) {} }
  }
}

// ===== 多账号主流程 =====
async function runMultiCheckin(trigger, runState) {
  const results = [];

  // 0) 快照当前 cookie（结束后还原，保证浏览现场不变）
  const snapshot = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN });
  await setProgress(`已快照 ${snapshot.length} 条 cookie`);
  runState.snapshot = snapshot;
  await mirror(runState);

  const tab = await chrome.tabs.create({ url: CHECKIN_URL, active: false });
  runState.tabId = tab.id;
  await mirror(runState);
  await waitTabComplete(tab.id, 40000);

  await mirror(runState); // 心跳：下面的纠偏等待最长 30s
  // SPA 偶尔落在 /console 根页而非签到页：确认并纠偏，避免探测空转到超时
  try {
    const t = await chrome.tabs.get(tab.id);
    if (!(t.url || "").includes("/console/checkin")) {
      await chrome.tabs.update(tab.id, { url: CHECKIN_URL });
      await waitTabComplete(tab.id, 30000);
    }
  } catch (e) {}

  await mirror(runState); // 心跳：账号列表轮询最长 15s，别让看门狗误判
  // 1) 两路并发：先发出身份+积分请求，再拉账号列表——两者同时进行，省一次串行等待
  let others = [];
  let switchedAny = false;
  try { await exec(tab.id, startUserFetch); } catch (e) {}
  try {
    const accRaw = await pollInjected(tab.id, startAccountsFetch, [], readAccountsResult, 15000);
    try {
      if (!accRaw) throw new Error("接口 15 秒无响应");
      const acc = JSON.parse(accRaw);
      if (acc && acc.code === 0 && Array.isArray(acc.data)) {
        // 顺手提取每个账号的积分余额（零额外请求；字段名未逆向确认，按含 point 的数字字段宽松探测）
        const info = acc.data
          .filter((a) => a && (a.userId != null || a.id != null))
          .map((a) => ({
            userId: a.userId ?? a.id,
            email: a.email || a.username || a.nickname || "",
            current: !!(a.current || a.isCurrent || a.is_current),
            balance: findPoints(a),
          }));
        runState.acctInfo = info;
        others = info
          .filter((x) => !x.current) // 跳过当前账号，避免对它重复签到
          .map((x) => ({ userId: x.userId, email: x.email, balance: x.balance }));
      } else {
        const detail = "接口返回异常: " + JSON.stringify(acc).slice(0, 120);
        results.push({ who: "账号列表", status: "error", message: detail });
        runState.accounts.push({ who: "账号列表", status: "failed", detail });
        await mirror(runState);
      }
    } catch (e) {
      const detail = "账号列表失败: " + String((e && e.message) || accRaw || "空响应").slice(0, 120);
      results.push({ who: "账号列表", status: "error", message: detail });
      runState.accounts.push({ who: "账号列表", status: "failed", detail: detail.replace("账号列表失败: ", "") });
      await mirror(runState);
    }
  } catch (e) {
    const detail = String((e && e.message) || e);
    results.push({ who: "账号列表", status: "error", message: detail });
    runState.accounts.push({ who: "账号列表", status: "failed", detail });
    await mirror(runState);
  }

  // 2) 当前账号签到：账号列表只含其他绑定账号（实测无 current 标记），
  //    当前账号的邮箱/积分要从用户信息接口拿；接口全部落空才退回"当前账号"。
  //    请求已在第 1 步并行发出，这里只等结果（通常已就绪，≈0 延迟）
  await mirror(runState); // 心跳
  const userInfo = parseUserInfo(await awaitResult(tab.id, readUserResult, 12000));
  runState.originalUid = userInfo.uid != null ? userInfo.uid : undefined;
  runState.originalEmail = userInfo.email || "";
  runState.accounts.push({
    who: userInfo.email || "当前账号",
    status: "signing",
    detail: "页面加载中",
    balance: userInfo.balance != null ? userInfo.balance : undefined,
    streak: userInfo.streak != null ? userInfo.streak : undefined,
  });
  await mirror(runState);
  let r = await clickFlowWithRetry(tab.id, 0, runState);
  if (r.status === "not-logged-in") {
    results.push({ who: runState.accounts[0].who, ...r });
    await finalizeRun(results, runState, false);
    return results;
  }
  applyResult(runState, 0, r);
  results.push({ who: runState.accounts[0].who, balance: runState.accounts[0].balance, streak: runState.accounts[0].streak, ...r });

  // 3) 逐个切换 → 签到
  try {
    for (const acc of others) {
      const idx = runState.accounts.length;
      runState.accounts.push({
        who: acc.email || `用户 ${acc.userId}`,
        status: "switching",
        detail: "",
        balance: acc.balance,
      });
      await setProgress(`切换到 ${acc.email || acc.userId} …`);
      await mirror(runState);

      const swRaw = await pollInjected(tab.id, startSwitch, [acc.userId], readSwitchResult, 15000);
      let sw = { http: 0, error: "切换请求 15 秒无响应" };
      try { if (swRaw) sw = JSON.parse(swRaw); } catch (e) { sw = { http: 0, error: "切换响应解析失败" }; }
      if (sw.http !== 200 || (sw.code != null && sw.code !== 0)) {
        runState.accounts[idx].status = "failed";
        runState.accounts[idx].detail = `切换失败: ${sw.message || sw.error || "未知"}`;
        results.push({ who: runState.accounts[idx].who, status: "error", message: runState.accounts[idx].detail });
        runState.done = (runState.done || 0) + 1;
        await mirror(runState);
        continue;
      }
      switchedAny = true;
      // 切换成功 → cookie 已是新账号，身份/积分请求立即并行发出（不必等页面重载）
      const uiP = fetchUserInfo(tab.id);
      // 以新账号身份重新加载签到页
      await chrome.tabs.update(tab.id, { url: CHECKIN_URL });
      await waitTabComplete(tab.id, 40000);
      await sleep(500); // 剩余初始化交给 clickFlow 轮询去等，不必死等
      runState.accounts[idx].status = "signing";
      runState.accounts[idx].detail = "页面加载中";
      // 核实切换后的真实身份（邮箱）+ 顺带拿该账号积分余额
      const ui = await uiP;
      if (ui.email) runState.accounts[idx].who = ui.email;
      if (ui.balance != null) runState.accounts[idx].balance = ui.balance;
      if (ui.streak != null) runState.accounts[idx].streak = ui.streak;
      await mirror(runState);

      r = await clickFlowWithRetry(tab.id, idx, runState);
      if (r.status === "not-logged-in") {
        runState.accounts[idx].status = "failed";
        runState.accounts[idx].detail = "切换后未登录（异常）";
        results.push({ who: runState.accounts[idx].who, status: "error", message: "切换后未登录（异常）" });
        await mirror(runState);
        continue;
      }
      applyResult(runState, idx, r);
      results.push({ who: runState.accounts[idx].who, balance: runState.accounts[idx].balance, streak: runState.accounts[idx].streak, ...r });
    }
  } catch (e) {
    // 枚举/切换环节的意外错误：记录后继续走还原，保证会话现场不丢
    const detail = String((e && e.message) || e);
    results.push({ who: "后续账号流程", status: "error", message: detail });
    runState.accounts.push({ who: "后续账号流程", status: "failed", detail });
    await mirror(runState);
  }

  // 4) 还原会话现场（切回运行前账号）——只要切换过就还原，前面出错也不例外。
  //    优先用官方切换接口切回原账号（switch 本来就是官方的"切回"机制，比 cookie
  //    手术可靠——cookie set 失败会静默返回 null，此前还原一直没生效）；再核实身份
  if (switchedAny) {
    await setProgress("还原会话现场…");
    runState.phase = "restore";
    let restored = false;
    let back = {};
    try {
      if (runState.originalUid != null) {
        const swRaw = await pollInjected(tab.id, startSwitch, [runState.originalUid], readSwitchResult, 15000);
        let sw = {};
        try { if (swRaw) sw = JSON.parse(swRaw); } catch (e) {}
        restored = sw.http === 200 && (sw.code == null || sw.code === 0);
      }
    } catch (e) {}
    try { back = await fetchUserInfo(tab.id); } catch (e) {}
    if (back.email && runState.originalEmail && back.email === runState.originalEmail) restored = true;
    if (!restored) {
      // 官方切回不可用（或原账号 uid 未知）→ cookie 快照兜底，再核实一次
      try { await restoreCookies(snapshot); } catch (e) {}
      try { back = await fetchUserInfo(tab.id); } catch (e) {}
      if (back.email && runState.originalEmail && back.email === runState.originalEmail) restored = true;
    }
    if (restored) {
      const backWho = (back && back.email) || runState.originalEmail || "原账号";
      results.push({
        who: "还原",
        status: "restored",
        message: `已切回 ${backWho}`,
        balance: back && back.balance,
        streak: back && back.streak,
      });
      runState.accounts.push({
        who: "还原",
        status: "restored",
        detail: `已切回 ${backWho}`,
        balance: back && back.balance,
        streak: back && back.streak,
      });
    } else {
      // 还原是锦上添花（切不切都可以）：失败只作提醒，不计成败、不触发重试
      results.push({ who: "会话还原", status: "restore-failed", message: "未能切回原账号，可在控制台手动切换" });
      runState.accounts.push({ who: "会话还原", status: "restore-failed", detail: "未能切回原账号，可在控制台手动切换" });
    }
    await mirror(runState);
  }

  // 5) 汇总
  await finalizeRun(results, runState, true);
  return results;
}

function applyResult(runState, idx, r) {
  const row = runState.accounts[idx];
  row.status = r.status === "success" ? "success" : r.status === "already" ? "already" : "failed";
  row.detail = [
    r.points !== "" && r.points != null ? `+${r.points}` : "",
    r.message || r.reason || "",
  ]
    .filter(Boolean)
    .join(" · ");
  runState.done = (runState.done || 0) + 1; // 运行级进度：已完成账号数
}

// 在任意嵌套对象里找第一个含 point 的数字/数字串字段（积分余额；
// /api/user/accounts 元素的字段名未逆向确认，宽松匹配，找不到就返回 null 隐藏展示）
function findPoints(obj, depth = 0) {
  if (depth > 4 || obj == null || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findPoints(v, depth + 1);
      if (r != null) return r;
    }
    return null;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const numeric = typeof v === "number" || (typeof v === "string" && v !== "" && !isNaN(Number(v)));
    if (/point/i.test(k) && numeric) return Number(v);
  }
  for (const k of Object.keys(obj)) {
    const r = findPoints(obj[k], depth + 1);
    if (r != null) return r;
  }
  return null;
}

// 在任意嵌套对象里找第一个含 mail 的字符串字段且形如邮箱（用户信息接口字段名不确定，宽松匹配）
function findEmail(obj, depth = 0) {
  if (depth > 4 || obj == null || typeof obj !== "object") return "";
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findEmail(v, depth + 1);
      if (r) return r;
    }
    return "";
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (/mail/i.test(k) && typeof v === "string" && v.includes("@")) return v;
  }
  for (const k of Object.keys(obj)) {
    const r = findEmail(obj[k], depth + 1);
    if (r) return r;
  }
  return "";
}

// 在任意嵌套对象里找第一个形如用户 id 的字段（官方切换接口要 {userId}，原账号 id 从这里来）
function findUid(obj, depth = 0) {
  if (depth > 4 || obj == null || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findUid(v, depth + 1);
      if (r != null) return r;
    }
    return null;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const numeric = typeof v === "number" || (typeof v === "string" && v !== "" && !isNaN(Number(v)));
    if (/^(id|userid|user_id|uid)$/i.test(k) && numeric) return Number(v);
  }
  for (const k of Object.keys(obj)) {
    const r = findUid(obj[k], depth + 1);
    if (r != null) return r;
  }
  return null;
}

// 解析用户信息原始响应（身份 + 积分 + 连签 + 原账号 uid——官方切回要用）
function parseUserInfo(raw) {
  if (!raw) return {};
  try {
    const d = JSON.parse(raw);
    if (!d || !d.ok) return {};
    return {
      email: findEmail(d.id) || "",
      uid: findUid(d.id),
      balance: d.balance != null ? d.balance : findPoints(d.id),
      streak: d.streak != null ? d.streak : undefined,
    };
  } catch (e) {
    return {};
  }
}

// 查当前登录用户：发起 + 轮询取回（切换后逐账号调用）
async function fetchUserInfo(tabId) {
  return parseUserInfo(await pollInjected(tabId, startUserFetch, [], readUserResult, 12000));
}

// 只轮询取回（发起已提前做过）——供并行请求"先发后收"的场景；
// 全局变量丢失（整页导航）时返回空串，由调用方降级
async function awaitResult(tabId, readFn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 先读后睡：请求常在几百毫秒内就绪，白睡固定间隔是纯浪费
    let v = "";
    try {
      const [rd] = await exec(tabId, readFn);
      v = (rd && rd.result) || "";
    } catch (e) {
      v = "";
    }
    if (v && v !== "PENDING") return v;
    if (v !== "PENDING") return "";
    await sleep(500);
  }
  return "";
}

// 带后台超时重试的点击流程：后台标签页里 Turnstile 可能被浏览器节流，
// 首次超时后把标签页提到前台再试一次，结束归还后台
async function clickFlowWithRetry(tabId, idx, runState) {
  let r = await clickFlow(tabId, idx, runState);
  if (r.status !== "page-timeout") return r;
  try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
  if (runState.accounts[idx]) {
    runState.accounts[idx].status = "signing";
    runState.accounts[idx].detail = "后台超时，提到前台重试";
  }
  await mirror(runState);
  try {
    r = await clickFlow(tabId, idx, runState);
  } finally {
    try { await chrome.tabs.update(tabId, { active: false }); } catch (e) {}
  }
  return r;
}

// 单账号点击流程（短轮询；每轮更新心跳与该账号的实时状态）
async function clickFlow(tabId, idx, runState) {
  let patched = false;
  let clicked = false;
  let clickAt = 0; // 像人一样：按钮出现后随机停留 0.8~2.5s 再点，不在出现的瞬间点
  const startAt = Date.now();
  for (let i = 0; i < 50; i++) {
    runState.heartbeat = Date.now(); // 心跳
    const elapsed = Math.round((Date.now() - startAt) / 1000);
    if (runState.accounts[idx] && runState.accounts[idx].status === "signing") {
      runState.accounts[idx].detail = `等待验证结果 (${elapsed}s)`;
    }
    await mirror(runState);
    // 运行级进度（行内步骤条已有账号级状态，顶栏不重复说同一件事）
    // 总数 = 切换目标数（他人列表）+ 当前账号
    const total = ((runState.acctInfo && runState.acctInfo.length) || 0) + 1;
    await setProgress(`已完成 ${runState.done || 0}/${total} · 当前签到 ${elapsed}s`);

    let st = null;
    try {
      const [r] = await exec(tabId, stepOnce, [clicked]);
      st = r && r.result;
    } catch (e) {
      await sleep(1000);
      continue; // 上下文被 SPA 路由销毁，下一轮恢复
    }
    if (!st) { await sleep(1000); continue; }

    if (st.notLoggedIn) return { status: "not-logged-in", message: "被重定向到登录页/落地页" };
    if (st.alreadySigned) return { status: "already", message: st.message || "页面显示今日已签到" };
    if (st.marker) {
      try {
        const d = JSON.parse(st.marker);
        return {
          status: d.code === 0 ? "success" : d.code === 1 ? "already" : "rejected",
          code: d.code,
          message: d.message || "",
          points: d.points ?? "",
          reason: d.reason || "",
        };
      } catch (e) {
        return { status: "parse-error", raw: String(st.marker).slice(0, 200) };
      }
    }

    // 按钮出现又消失 → 重置停留计时；只在"从没见过按钮"时才判 40 秒无按钮
    if (!clicked && clickAt && !st.hasButton) clickAt = 0;
    // 页面迟迟不给按钮（未渲染完/非签到页）：别干等满轮，提前转前台重试
    if (!clicked && !clickAt && i >= 40) {
      return { status: "page-timeout", message: "40 秒未见可点击的签到按钮，转前台重试" };
    }

    if (!patched) {
      try { await exec(tabId, patchNet, [], "MAIN"); patched = true; } catch (e) {}
    }
    if (st.hasButton && !clicked && patched) {
      if (!clickAt) clickAt = Date.now() + 800 + Math.floor(Math.random() * 1700);
      if (Date.now() >= clickAt) {
        clicked = true;
        try { await exec(tabId, clickBtn); } catch (e) { clicked = false; }
      }
    }
    await sleep(1000);
  }
  return { status: "page-timeout", message: `约 60 秒内未完成签到流程（点击=${clicked}）` };
}

// 汇总落盘：lastResults + history + 角标 + 通知
async function finalizeRun(results, runState, notify) {
  runState.active = false;
  runState.heartbeat = Date.now();
  // lastResultsDate：结果所属日期——次日早上横幅要据此区分"昨日成功"与"今日失败"
  await chrome.storage.local.set({ runState, lastResults: results, lastResultsDate: todayStr() });
  // 还原是锦上添花（切不切都可以）：restore-failed 不计入成败、不触发重试
  const crit = results.filter((x) => x.status !== "restore-failed");
  const okCount = crit.filter((x) => x.status === "success" || x.status === "already" || x.status === "restored").length;
  const allOk = crit.length > 0 && okCount === crit.length;
  // 通知里的"N/N"只数账号行（还原是会话状态，不是账号）
  const acctRows = results.filter((x) => x.status !== "restored" && x.status !== "restore-failed");
  const acctOk = acctRows.filter((x) => x.status === "success" || x.status === "already").length;
  const historyNew = results.map((x) => ({
    date: todayStr(),
    time: new Date().toTimeString().slice(0, 5),
    trigger: runState.trigger,
    who: x.who,
    balance: x.balance ?? "",
    streak: x.streak,
    status: x.status,
    message: x.message || "",
    points: x.points ?? "",
  }));
  const { history = [] } = await chrome.storage.local.get("history");
  await chrome.storage.local.set({ history: [...historyNew, ...history].slice(0, 60) });

  if (allOk) {
    await chrome.storage.local.set({ lastSuccessDate: todayStr() });
    await setBadge("✓", "#1a7f37");
    chrome.alarms.clear(RETRY); // 成功了就取消挂着的重试
    if (notify) {
      try {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "GLaDOS 多账号签到完成",
          message: `${acctOk}/${acctRows.length} 个账号签到成功`,
        });
      } catch (e) {}
    }
  } else {
    await setBadge("✗", "#b91c1c");
    // 瞬态失败 → 自动重试；"未登录"类失败需要人工登录，不自动重试
    const needsLogin = results.some((x) => x.status === "not-logged-in");
    // 失败系统通知：每天只提醒第一次（后续重试不刷屏）——静默失败等于当天积分白丢
    const { failNotifiedDate = "" } = await chrome.storage.local.get("failNotifiedDate");
    if (failNotifiedDate !== todayStr()) {
      await chrome.storage.local.set({ failNotifiedDate: todayStr() });
      try {
        // 未成功计数只算账号行（还原行不是账号，还原失败也不触发本通知路径）
        const failCount = crit.filter(
          (x) => !(x.status === "success" || x.status === "already" || x.status === "restored")
        ).length;
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: needsLogin ? "GLaDOS 签到失败：需要重新登录" : "GLaDOS 签到失败",
          message: needsLogin
            ? "会话已失效，请在控制台重新登录后点面板的「立即签到」"
            : `${failCount} 个账号未成功，将自动重试`,
        });
      } catch (e) {}
    }
    if (!needsLogin) {
      await scheduleRetry();
    }
  }
  await setProgress(`完成：${okCount}/${results.length} 成功`);
}

// ===== Cookie 快照/还原 =====
// 单条 cookie 还原：先带 domain（域 cookie 形态），失败再不带（host-only 形态）。
// chrome.cookies.set 失败时不抛错、只返回 null——必须检查返回值，否则会静默失败
async function setCookieSafe(c) {
  const domain = String(c.domain || COOKIE_DOMAIN).replace(/^\./, "");
  const url = `https://${domain}${c.path || "/"}`;
  const base = {
    url,
    name: c.name,
    value: c.value,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (c.expirationDate) base.expirationDate = c.expirationDate;
  if (c.sameSite) base.sameSite = c.sameSite;
  let ok = null;
  if (c.domain) {
    try { ok = await chrome.cookies.set({ ...base, domain: c.domain }); } catch (e) {}
  }
  if (!ok) {
    try { ok = await chrome.cookies.set(base); } catch (e) {}
  }
  return ok != null;
}

async function restoreCookies(snapshot) {
  // 先删掉运行期间新增的 cookie（快照里没有的），再逐条还原，保证现场完全一致。
  // 返回是否全部成功——调用方（还原阶段）会再用身份核实做最终判定
  const keep = new Set(snapshot.map((c) => `${c.name}|${c.domain}|${c.path}`));
  let current = [];
  try { current = await chrome.cookies.getAll({ domain: COOKIE_DOMAIN }); } catch (e) {}
  for (const c of current) {
    if (!keep.has(`${c.name}|${c.domain}|${c.path}`)) {
      try {
        await chrome.cookies.remove({
          url: `https://${String(c.domain).replace(/^\./, "")}${c.path || "/"}`,
          name: c.name,
        });
      } catch (e) {}
    }
  }
  let allOk = true;
  for (const c of snapshot) {
    const ok = await setCookieSafe(c);
    if (!ok) allOk = false;
  }
  return allOk;
}

async function waitTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return;
    await sleep(300);
  }
}

// ===== 注入执行辅助 =====
// 注意：Chrome 的 scripting.executeScript 没有 awaitPromise 属性（那是 Firefox 的），
// 传了直接报 "Unexpected property"。注入函数必须写成同步的；异步结果走两段式（见 pollInjected）
async function exec(tabId, func, args, world) {
  const opts = { target: { tabId }, func, args: args || [] };
  if (world) opts.world = world; // patchNet 必须注入 MAIN world，否则拦截不到页面自己的 fetch/XHR
  return chrome.scripting.executeScript(opts);
}

// 两段式异步取回：注入"发起"函数（fetch 落到 isolated world 的全局变量），
// 再轮询"读取"函数直到结果就绪或超时。整页导航会换新的 isolated world 丢全局变量，
// 此时读取结果为空 → 重新发起（账号列表 GET 幂等；switch 重发无害）
async function pollInjected(tabId, startFn, startArgs, readFn, timeoutMs) {
  await exec(tabId, startFn, startArgs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 先读后睡：结果常在发起后几百毫秒就绪，固定先睡是纯浪费
    let v = "";
    try {
      const [rd] = await exec(tabId, readFn);
      v = (rd && rd.result) || "";
    } catch (e) {
      v = "";
    }
    if (v && v !== "PENDING") return v;
    if (v !== "PENDING") {
      try { await exec(tabId, startFn, startArgs); } catch (e2) {}
    }
    await sleep(500);
  }
  return "";
}


// ===== 账号列表/切换：同步发起 + 全局变量回传（配合 pollInjected 两段式）=====
function startAccountsFetch() {
  // 前端 axios 实例 baseURL 为 /api，故真实路径带 /api 前缀
  window.__gladosAccts = "PENDING";
  fetch("/api/user/accounts", { headers: { Accept: "application/json" }, credentials: "include" })
    .then((r) => r.text())
    .then((t) => { window.__gladosAccts = t; })
    .catch((e) => { window.__gladosAccts = JSON.stringify({ code: -999, message: String(e) }); });
}

function readAccountsResult() {
  return window.__gladosAccts || "";
}

function startUserFetch() {
  window.__gladosUser = "PENDING";
  // 已逆向确认（console chunk main~21b3c6c3 的 loadPoints）：
  //   GET /api/user/points → { code, points:总积分, history:流水, streak:连签, games, spinsLeft }
  // 身份（当前账号邮箱）：/api/user/accounts 只含其他账号，需用户信息接口——
  //   /api/user/info 在 bundle 中确认存在，另附常见候选；响应含邮箱/用户名才算命中
  (async () => {
    const identity = (async () => {
      for (const u of ["/api/user/info", "/api/user/status", "/api/user/main", "/api/user/me"]) {
        try {
          const r = await fetch(u, { headers: { Accept: "application/json" }, credentials: "include" });
          const t = await r.text();
          let d = null;
          try { d = JSON.parse(t); } catch (e) { d = null; }
          const o = d && typeof d === "object" ? (d.data && typeof d.data === "object" ? d.data : d) : null;
          if (o && (o.email || o.username || o.user_name)) return o;
        } catch (e) {}
      }
      return null;
    })();
    let balance = null;
    let streak = null;
    try {
      const r = await fetch("/api/user/points", { headers: { Accept: "application/json" }, credentials: "include" });
      const d = await r.json();
      if (d && d.code === 0) {
        if (d.points != null) balance = Number(d.points) || 0;
        if (d.streak != null) streak = d.streak;
      }
    } catch (e) {}
    const id = await identity;
    if (!id && balance == null) {
      window.__gladosUser = JSON.stringify({ ok: false });
      return;
    }
    window.__gladosUser = JSON.stringify({ ok: true, balance, streak, id });
  })();
}

function readUserResult() {
  return window.__gladosUser || "";
}

function startSwitch(userId) {
  window.__gladosSwitch = "PENDING";
  fetch("/api/user/accounts/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: JSON.stringify({ userId: Number(userId) }),
  })
    .then((r) =>
      r
        .json()
        .catch(() => ({}))
        .then((d) => JSON.stringify({ http: r.status, code: d.code, message: d.message || "" }))
    )
    .then((s) => { window.__gladosSwitch = s; })
    .catch((e) => { window.__gladosSwitch = JSON.stringify({ http: 0, error: String(e) }); });
}

function readSwitchResult() {
  return window.__gladosSwitch || "";
}

function patchNet() {
  if (window.__gladosPatched) return;
  window.__gladosPatched = true;
  const mark = (v) =>
    document.documentElement.setAttribute("data-glados-checkin", typeof v === "string" ? v : JSON.stringify(v));
  // 只标记最终签到 POST 的响应。签到流程第一步是 GET /user/checkin/challenge（返回
  // nonce 配置而非结果），若一并拦截会被误当成签到结果提前解析
  const isFinal = (u, m) =>
    String(u).includes("/user/checkin") &&
    !String(u).includes("challenge") &&
    String(m || "").toUpperCase() === "POST";
  // fetch 与 XHR 各自独立容错：一段失败不能拖死另一段
  // （例如环境里没有 XMLHttpRequest 时，fetch 拦截仍应保留）
  try {
    const of = window.fetch;
    if (of) {
      window.fetch = async function (...a) {
        const resp = await of.apply(this, a);
        try {
          const u = typeof a[0] === "string" ? a[0] : (a[0] && a[0].url) || "";
          const m = (a[1] && a[1].method) || (a[0] && a[0].method) || "";
          if (isFinal(u, m)) {
            const c = resp.clone();
            c.text().then(mark);
          }
        } catch (e) {}
        return resp;
      };
    }
  } catch (e) {}
  try {
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.addEventListener("load", function () {
        try {
          if (isFinal(u, m)) mark(this.responseText);
        } catch (e) {}
      });
      return oo.apply(this, arguments);
    };
  } catch (e) {}
}

function clickBtn() {
  const b = [...document.querySelectorAll("button, a")].find((x) => /签到|check\s?in/i.test(x.innerText || ""));
  if (!b) return;
  try { b.scrollIntoView({ block: "center" }); } catch (e) {}
  b.click();
}

function stepOnce(clicked) {
  const url = location.href;
  // 扫描上限要足够大：控制台导航/弹窗文字多时会挤到"Return tomorrow"之前，
  // 3000 字符曾导致已签状态探测不到、干等超时（67s 卡顿观感的根因）
  const body = document.body ? document.body.innerText.slice(0, 20000) : "";

  const notLoggedIn =
    url.includes("authenticate") ||
    url.includes("/login") ||
    (body.includes("Create a free account") && body.includes("Log in"));
  if (notLoggedIn) return { notLoggedIn: true };

  if (!url.includes("/console")) return {};

  const got = [...document.querySelectorAll("button")].find((b) => /got it/i.test(b.innerText || ""));
  if (got) { try { got.click(); } catch (e) {} }

  // 已拿到签到接口响应时优先返回：真签到成功后页面文本会变成“签到成功”，
  // 若文本检查在前会误报“今日已签”并丢失积分信息
  const marker = document.documentElement.getAttribute("data-glados-checkin") || "";
  if (marker) return { marker };

  if (/Return tomorrow|Come back tomorrow|已签到|签到成功/i.test(body)) {
    return { alreadySigned: true, message: "页面显示今日已签到" };
  }

  const btn = [...document.querySelectorAll("button, a")].find((b) =>
    /签到|check\s?in/i.test(b.innerText || "")
  );
  return { hasButton: !!btn, clickedWas: !!clicked, marker };
}
