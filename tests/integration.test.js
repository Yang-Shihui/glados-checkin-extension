// 集成测试：模拟 chrome.* 与 GLaDOS 页面，端到端跑 background.js 的完整状态机
// 运行：node tests/integration.test.js（约 30~60 秒，纯 Node 无依赖）
//
// 模拟的"服务端"行为：
//   - 两个绑定账号 orig(111222)/other(333444)，other 今天已签
//   - /api/user/accounts 只返回 other（与真实站点一致）
//   - /api/user/info 返回当前会话账号的 email/id；/api/user/points 返回积分/连签
//   - 点击签到按钮 1.2 秒后页面产生签到响应（写入 marker 属性）
//   - /api/user/accounts/switch 真正切换 mock 会话（可断言"切回"是否生效）
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

const CHECKIN_URL = "https://glados.rocks/console/checkin";
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) console.log("PASS", name, extra || "");
  else { console.log("FAIL", name, extra || ""); fail++; }
};

function mkLC() {
  const ls = [];
  return { addListener(cb) { ls.push(cb); }, async fire(...a) { for (const cb of ls) await cb(...a); } };
}

function makeEnv(opts = {}) {
  const store = {};
  const alarms = {};
  const switchLog = [];
  const notifLog = [];
  const badgeLog = [];
  const tabs = {};
  let nextTabId = 1;
  let sessionAccount = "orig";
  const accountsState = {
    orig: { email: "orig@gmail.com", uid: 111222, signed: false, points: 108, streak: 1 },
    other: { email: "other@gmail.com", uid: 333444, signed: true, points: 340, streak: 5 },
  };
  const cookieStore = {
    "gld:sess|glados.rocks|/": { name: "gld:sess", value: "orig_sess", domain: "glados.rocks", path: "/", secure: true },
    "gld:sess.sig|glados.rocks|/": { name: "gld:sess.sig", value: "orig_sig", domain: "glados.rocks", path: "/", secure: true },
  };

  // 模拟页面（按当前会话账号的"已签状态"生成）
  function pageFor() {
    const acct = accountsState[sessionAccount];
    if (opts.loggedOut || !acct) {
      return { bodyText: "Create a free account Log in", hasCheckinButton: false, marker: null, clicked: false };
    }
    if (acct.signed) {
      return { bodyText: "console body Return tomorrow for more points.", hasCheckinButton: false, marker: null, clicked: false };
    }
    return { bodyText: "console body Check in", hasCheckinButton: true, marker: null, clicked: false };
  }

  function simulateCheckin(page) {
    const acct = accountsState[sessionAccount];
    acct.signed = true;
    page.marker = opts.failMarker
      ? JSON.stringify({ code: 5, reason: "turnstile", message: "Cloudflare verification failed" })
      : JSON.stringify({ code: 0, message: "Check-in success", points: 7.2 });
    page.bodyText += " 签到成功";
  }

  function docFor(page) {
    return {
      // marker 属性映射 page.marker——真实站点里由 patchNet 的 mark() 写入，语义一致
      documentElement: {
        getAttribute(n) { return n === "data-glados-checkin" ? page.marker || null : null; },
        setAttribute(n, v) { if (n === "data-glados-checkin") page.marker = v; },
      },
      body: { get innerText() { return page.bodyText; } },
      querySelectorAll() {
        if (page.hasCheckinButton && !page.clicked) {
          return [{ innerText: "Check in", click() { page.clicked = true; setTimeout(() => simulateCheckin(page), 1200); } }];
        }
        return [];
      },
    };
  }

  function worldFor(tab, isMain) {
    // window 全局按 world 缓存（模拟隔离世界的持久性），
    // 但 document 必须每次重绑——整页导航后旧 document 的 marker 不能残留
    if (isMain) {
      if (!tab.mainWorld) tab.mainWorld = { window: {} };
      tab.mainWorld.document = tab.doc;
      return tab.mainWorld;
    }
    if (!tab.isoWorld) tab.isoWorld = { window: {} };
    tab.isoWorld.document = tab.doc;
    return tab.isoWorld;
  }

  async function fetchMock(u, o) {
    u = String(u);
    const json = (d) => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
    const notFound = { ok: false, status: 404, json: async () => { throw new Error("404"); }, text: async () => "Not Found" };
    if (u === "/api/user/accounts") {
      if (opts.loggedOut || !accountsState[sessionAccount]) return json({ code: -2, message: "session invalid" });
      return json({ code: 0, data: [{ userId: 333444, email: "other@gmail.com" }] });
    }
    if (u === "/api/user/info") {
      if (opts.loggedOut || !accountsState[sessionAccount]) return json({ code: -2 });
      const a = accountsState[sessionAccount];
      return json({ code: 0, data: { email: a.email, id: a.uid } });
    }
    if (u === "/api/user/status") return json({ code: -2 });
    if (u === "/api/user/points") {
      if (opts.loggedOut || !accountsState[sessionAccount]) return json({ code: -2 });
      const a = accountsState[sessionAccount];
      return json({ code: 0, points: a.points, streak: a.streak });
    }
    if (u === "/api/user/accounts/switch" && o && o.method === "POST") {
      const body = JSON.parse(o.body);
      const key = Object.keys(accountsState).find((k) => accountsState[k].uid === body.userId);
      if (!key) return json({ code: -1, message: "no such account" });
      sessionAccount = key;
      switchLog.push(body.userId);
      cookieStore["gld:sess|glados.rocks|/"].value = "sess_" + key;
      return json({ code: 0, message: "switched" });
    }
    return notFound;
  }

  const msgLC = mkLC();
  const alarmLC = mkLC();
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (store[k] !== undefined) out[k] = store[k];
          return out;
        },
        async set(o) { Object.assign(store, o); },
      },
    },
    alarms: {
      create(name, opts2) { alarms[name] = opts2; },
      clear(name) { const had = name in alarms; delete alarms[name]; return had; },
      onAlarm: alarmLC,
    },
    runtime: {
      onInstalled: mkLC(),
      onStartup: mkLC(),
      onMessage: msgLC,
      getManifest: () => ({ version: "0.0.0-test" }),
    },
    tabs: {
      async create(o) {
        const id = nextTabId++;
        tabs[id] = { id, url: o.url, status: "complete", active: !!o.active, page: pageFor(), doc: null };
        tabs[id].doc = docFor(tabs[id].page);
        return { id };
      },
      async get(id) { const t = tabs[id]; if (!t) throw new Error("No such tab " + id); return t; },
      async update(id, o) {
        const t = tabs[id];
        if (!t) throw new Error("No such tab");
        if (o.url) { t.url = o.url; t.page = pageFor(); t.doc = docFor(t.page); }
        if ("active" in o) t.active = o.active;
        return t;
      },
      async remove(id) { delete tabs[id]; },
    },
    cookies: {
      async getAll() { return Object.values(cookieStore).map((c) => ({ ...c })); },
      async set(d) {
        const key = `${d.name}|${d.domain || "glados.rocks"}|${d.path || "/"}`;
        cookieStore[key] = { name: d.name, value: d.value, domain: d.domain || "glados.rocks", path: d.path || "/", secure: !!d.secure };
        return { ...cookieStore[key] };
      },
      async remove(d) {
        for (const k of Object.keys(cookieStore)) if (cookieStore[k].name === d.name) delete cookieStore[k];
        return {};
      },
    },
    scripting: {
      async executeScript(opts) {
        const t = tabs[opts.target.tabId];
        if (!t) throw new Error("No such tab " + opts.target.tabId);
        const w = worldFor(t, opts.world === "MAIN");
        const fn = new Function(
          "window", "document", "location", "fetch", "__args",
          `return (${opts.func.toString()})(...__args);`
        );
        const result = await fn(w.window, w.document, { href: t.url }, fetchMock, opts.args || []);
        return [{ result }];
      },
    },
    action: {
      async setBadgeText(o) { badgeLog.push(o.text); },
      async setBadgeBackgroundColor() {},
    },
    notifications: {
      create(o) { notifLog.push(o); },
      onClicked: mkLC(),
    },
  };

  async function waitDone(timeoutMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (store.running === false) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("运行超时未结束，progress=" + store.progress);
  }

  return { chrome, store, alarms, switchLog, notifLog, badgeLog, tabs, cookieStore, msgLC, alarmLC, waitDone };
}

// ===== 场景 1：新鲜日，两账号，真签到 + 切换 + 还原（主路径）=====
async function scenarioFreshSuccess() {
  console.log("--- 场景 1：新鲜日全流程 ---");
  const E = makeEnv({});
  new Function("chrome", src)(E.chrome);
  await E.msgLC.fire({ cmd: "run" }, null, () => {});
  await E.waitDone();

  const res = E.store.lastResults;
  console.log("[S1-RES]", JSON.stringify(res));
  ok(res.length === 3, "结果行数 3（账号0+账号1+还原）", `实际 ${res.length}`);
  ok(
    res[0].status === "success" && res[0].points === 7.2,
    "账号0 真签到成功 +7.2",
    JSON.stringify(res[0]).slice(0, 200)
  );
  ok(res[0].who === "orig@gmail.com", "row0 邮箱来自身份接口");
  ok(res[0].balance === 108 && res[0].streak === 1, "row0 积分/连签来自 /user/points");
  ok(res[1].status === "already" && res[1].who === "other@gmail.com", "账号1 切换后已签（身份核实）");
  ok(res[1].balance === 340, "账号1 积分 340");
  ok(res[2].status === "restored" && /orig@gmail\.com/.test(res[2].message), "还原行已切回原账号");
  ok(E.switchLog.join(",") === "333444,111222", "切换序列：先切他人 333444，再切回 111222");
  ok(E.store.lastSuccessDate === new Date().toLocaleDateString("sv-SE"), "lastSuccessDate=今日");
  ok(!("glados-retry" in E.alarms), "成功后无重试闹钟");
  ok(E.notifLog.some((n) => /完成/.test(n.title)), "成功系统通知");
  ok(!("failNotifiedDate" in E.store), "无失败通知记录");
  ok(Object.keys(E.tabs).length === 0, "后台标签页已关闭");
  ok(E.cookieStore["gld:sess|glados.rocks|/"].value === "sess_orig", "cookie 会话已切回 orig（官方切回生效）");
  ok(E.badgeLog.includes("✓"), "角标 ✓");
}

// ===== 场景 2：会话失效（未登录）=====
async function scenarioNotLoggedIn() {
  console.log("--- 场景 2：会话失效 ---");
  const E = makeEnv({ loggedOut: true });
  new Function("chrome", src)(E.chrome);
  await E.msgLC.fire({ cmd: "run" }, null, () => {});
  await E.waitDone();

  const res = E.store.lastResults;
  ok(res.some((x) => x.status === "not-logged-in"), "报未登录");
  ok(!("glados-retry" in E.alarms), "未登录不自动重试");
  ok(E.store.failNotifiedDate === new Date().toLocaleDateString("sv-SE"), "失败通知去重日期已记");
  ok(E.notifLog.some((n) => n.title.includes("需要重新登录")), "通知提示重新登录");
  ok(E.badgeLog.includes("✗"), "角标 ✗");
}

// ===== 场景 3：Turnstile 拒绝（瞬态失败 → 重试）=====
async function scenarioRejected() {
  console.log("--- 场景 3：Turnstile 拒绝 ---");
  const E = makeEnv({ failMarker: true });
  new Function("chrome", src)(E.chrome);
  await E.msgLC.fire({ cmd: "run" }, null, () => {});
  await E.waitDone();

  const res = E.store.lastResults;
  console.log("[S3-RES]", JSON.stringify(res));
  ok(res.some((x) => x.status === "rejected" && x.reason === "turnstile"), "被 Turnstile 拒绝（code 5）");
  ok("glados-retry" in E.alarms, "瞬态失败挂了重试闹钟");
  ok(E.store.failNotifiedDate === new Date().toLocaleDateString("sv-SE"), "失败通知日期已记");
  ok(E.notifLog.some((n) => n.title === "GLaDOS 签到失败"), "失败系统通知");
  ok(res.some((x) => x.status === "already"), "另一个账号仍正常已签");
}

// ===== 场景 4：看门狗清理死运行 =====
async function scenarioWatchdog() {
  console.log("--- 场景 4：看门狗 ---");
  const E = makeEnv({});
  new Function("chrome", src)(E.chrome);
  const tab = await E.chrome.tabs.create({ url: CHECKIN_URL, active: false });
  E.store.runState = {
    active: true,
    trigger: "auto",
    tabId: tab.id,
    heartbeat: Date.now() - 100000, // 心跳已死 100 秒
    accounts: [{ who: "orig@gmail.com", status: "signing" }],
    snapshot: [{ name: "gld:sess", value: "orig_sess", domain: "glados.rocks", path: "/", secure: true }],
  };
  E.store.running = true;
  await E.alarmLC.fire({ name: "glados-watchdog" });

  ok(E.store.runState.active === false, "看门狗判死运行");
  ok(E.store.runState.accounts[0].status === "failed", "中断行标记失败");
  ok(E.store.running === false, "运行锁已释放");
  ok("glados-retry" in E.alarms, "中断挂重试闹钟");
  ok(Object.keys(E.tabs).length === 0, "残留标签页已关");
  ok(E.badgeLog.includes("✗"), "角标 ✗");
}

(async () => {
  await scenarioFreshSuccess();
  await scenarioNotLoggedIn();
  await scenarioRejected();
  await scenarioWatchdog();
  console.log(fail === 0 ? "=== 集成测试全部通过 ===" : fail + " 处失败");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("测试崩溃:", e); process.exit(1); });
