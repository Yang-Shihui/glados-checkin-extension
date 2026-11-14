const $banner = document.getElementById("banner");
const $accounts = document.getElementById("accounts");
const $list = document.getElementById("list");
const $btn = document.getElementById("run");

// 版本徽标跟随 manifest，避免每次改版忘记同步
document.getElementById("ver").textContent = "v" + chrome.runtime.getManifest().version;

function todayStr() {
  return new Date().toLocaleDateString("sv-SE");
}

function esc(t) {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function okRow(r) {
  return r.status === "success" || r.status === "already" || r.status === "restored";
}

// 状态 → [文案, 药丸色, 是否进行中（转圈）]
const STATUS = {
  pending: ["排队中", "muted", true],
  signing: ["签到中", "warn", true],
  switching: ["切换中", "warn", true],
  success: ["签到成功", "ok", false],
  already: ["今日已签", "ok", false],
  restored: ["已还原", "ok", false],
  "restore-failed": ["未还原", "warn", false],
  "not-logged-in": ["未登录", "warn", false],
  rejected: ["被拒绝", "err", false],
  error: ["出错", "err", false],
  "no-response": ["无响应", "err", false],
  "page-timeout": ["超时", "err", false],
  "parse-error": ["解析失败", "err", false],
  "parse-accounts": ["账号列表失败", "err", false],
  failed: ["失败", "err", false],
  busy: ["进行中", "warn", true],
  unknown: ["未知", "warn", false],
};

function pillHtml(s) {
  const m = STATUS[s] || [s || "未知", "warn", false];
  return `${m[2] ? '<span class="spin"></span>' : ""}<span class="pill ${m[1]}">${esc(m[0])}</span>`;
}

function fullMsg(r) {
  return [r.message, r.reason, r.detail, r.raw].filter(Boolean).map(String).join(" · ");
}

// 状态横幅：页面第一眼看到的就是它（签到中 / 今日全部已签 / 未完成 / 待签到）
function renderBanner(st, rows, live) {
  let cls = "idle";
  let title = "待签到";
  let sub = "每天 12:15~12:45 / 19:00~19:20 随机自动运行";
  let spin = false;

  if (live || st.running) {
    const total = rows.length;
    const done = rows.filter((r) => ["success", "already", "failed"].includes(r.status)).length;
    const act = rows.find((r) => ["signing", "switching", "pending"].includes(r.status));
    cls = "run";
    spin = true;
    title = `签到中 ${done}/${total}`;
    sub = act && act.detail ? esc(act.detail) : esc((st.progress || "").split(" ").slice(1).join(" "));
  } else if (
    rows.length &&
    rows.filter((r) => r.status !== "restore-failed").every(okRow) &&
    st.lastSuccessDate === todayStr()
  ) {
    cls = "ok";
    title = "今日全部已签";
    const gain = rows.reduce((s, r) => s + (Number(r.points) || 0), 0);
    const parts = [];
    if (gain > 0) parts.push(`今日 +${gain}`);
    const t = (st.history || []).find((h) => h.date === todayStr());
    if (t && t.time) parts.push(`${esc(t.time)} 完成`);
    sub = parts.join(" · ") || "全部账号签到完成";
  } else if (rows.length && st.lastResultsDate === todayStr()) {
    // 只有"今天的"运行失败才标红——次日早上看到的昨天的全绿结果不吓人
    cls = "err";
    title = "今日未完成";
    sub = rows.some((r) => r.status === "not-logged-in")
      ? "需要先在控制台登录，再点下方按钮重试"
      : "将自动重试，也可点下方按钮立即签到";
  }

  $banner.className = "banner " + cls;
  $banner.innerHTML = `<div class="b-title">${spin ? '<span class="spin"></span>' : ""}${esc(
    title
  )}</div>${sub ? `<div class="b-sub">${sub}</div>` : ""}`;
}

// 账号卡：两行式——第一行邮箱+状态药丸，第二行积分/连签/当日增量（或失败原因）
function acctHtml(r) {
  const liveRow = ["signing", "switching", "pending"].includes(r.status);
  let sub = "";
  if (okRow(r)) {
    const parts = [];
    if (r.status === "success" && r.points != null && Number(r.points) > 0) {
      parts.push(`<span class="pts">+${esc(r.points)}</span>`);
    }
    if (r.balance != null && r.balance !== "") parts.push(`积分 ${esc(r.balance)}`);
    if (r.streak != null && Number(r.streak) > 0) parts.push(`连签 ${esc(r.streak)} 天`);
    if (r.status === "restored" && r.detail) parts.push(esc(r.detail));
    sub = parts.join('<span class="muted"> · </span>');
  } else if (liveRow) {
    sub = esc(r.detail || "");
  } else if (r.status === "restore-failed") {
    // 非致命：灰色提示而非红色报错
    const t = fullMsg(r);
    if (t) {
      const short = t.length > 46 ? t.slice(0, 46) + "…" : t;
      sub = `<span class="muted" title="${esc(t)}">${esc(short)}</span>`;
    }
  } else {
    const t = fullMsg(r);
    if (t) {
      const short = t.length > 46 ? t.slice(0, 46) + "…" : t;
      sub = `<span class="reason" title="${esc(t)}">${esc(short)}</span>`;
    }
  }
  const title = !okRow(r) && !liveRow && fullMsg(r) ? ` title="${esc(fullMsg(r))}"` : "";
  return `<div class="acct"${title}><div class="acct-top"><span class="who">${esc(
    r.who
  )}</span>${pillHtml(r.status)}</div>${sub ? `<div class="acct-sub">${sub}</div>` : ""}</div>`;
}

// 历史行的积分余额 + 连签（取不到就不显示；.detail 限宽防挤爆）
function balanceHtml(r) {
  if (r.balance == null || r.balance === "") return "";
  const streak = r.streak != null && Number(r.streak) > 0 ? ` · 连签 ${esc(r.streak)} 天` : "";
  return `<span class="muted detail">积分 ${esc(r.balance)}${streak}</span>`;
}

function histHtml(h) {
  const when = `${(h.date || "").slice(5)} ${h.time || ""}`;
  const gain =
    h.status === "success" && h.points != null && Number(h.points) > 0
      ? ` <span class="pts">+${esc(h.points)}</span>`
      : "";
  // 还原行把"切回到谁"亮出来（成功类默认不显示详情，还原是唯一有信息量的例外）
  const restoredNote =
    h.status === "restored" && h.message ? ` <span class="muted">${esc(h.message)}</span>` : "";
  const title = okRow(h) && h.status !== "restored" ? "" : ` title="${esc(fullMsg(h))}"`;
  return `<div class="item"${title}><span class="when">${esc(
    when
  )}</span><span class="who">${esc(h.who || "")}</span><span class="st">${pillHtml(
    h.status
  )}${balanceHtml(h)}${gain}${restoredNote}</span></div>`;
}

async function render() {
  const st = await chrome.storage.local.get([
    "lastResults",
    "lastResultsDate",
    "history",
    "lastSuccessDate",
    "progress",
    "runState",
    "running",
  ]);

  // 运行中：实时步骤条；结束：上一次结果；运行被中断（lastResults 为空）时展示中断现场
  const live =
    st.runState &&
    st.runState.active &&
    Array.isArray(st.runState.accounts) &&
    st.runState.accounts.length > 0;
  const rows = live
    ? st.runState.accounts
    : st.lastResults && st.lastResults.length
      ? st.lastResults
      : st.runState && Array.isArray(st.runState.accounts)
        ? st.runState.accounts
        : [];

  renderBanner(st, rows, live);
  // 只检测到 1 个账号时的引导提示（开源用户常见困惑点）
  const singleHint =
    !live && rows.length === 1 && okRow(rows[0])
      ? '<div class="muted" style="font-size:11px; line-height:1.6; margin:2px 2px 6px;">只检测到 1 个账号——要多账号一起签，请在控制台右上角账号菜单「添加账号」绑定</div>'
      : "";
  $accounts.innerHTML = rows.map(acctHtml).join("") + singleHint;

  if (st.running) {
    $btn.disabled = true;
    $btn.textContent = "签到中…（后台运行，面板自动刷新）";
  } else {
    $btn.disabled = false;
    $btn.textContent = "立即签到（全部账号）";
  }

  const hist = st.history || [];
  $list.innerHTML = hist.length
    ? hist.map(histHtml).join("")
    : '<div class="item"><span class="when">暂无记录</span></div>';
}

$btn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ cmd: "run" });
  await render();
});

render();
// 弹窗打开期间每 1.5 秒刷新，横幅/步骤条实时跳动
setInterval(render, 1500);
