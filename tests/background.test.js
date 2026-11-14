// background.js 提取出的纯函数单测（findPoints / findEmail / findUid）
// 运行：node tests/background.test.js
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

let fail = 0;
const extract = (name) => {
  const m = src.match(new RegExp(`function ${name}[\\s\\S]*?\\n\\}`));
  if (!m) { console.log("FAIL 未找到函数", name); fail++; return null; }
  return new Function("return " + m[0])();
};
const findPoints = extract("findPoints");
const findEmail = extract("findEmail");
const findUid = extract("findUid");

const t = (fn, name, input, want) => {
  const got = fn(input);
  if (got !== want) { console.log("FAIL", name, "got", got, "want", want); fail++; }
  else console.log("PASS", name);
};

// ===== findPoints：宽松积分探测 =====
t(findPoints, "顶层 points", { userId: 1, email: "a@b.c", points: 660 }, 660);
t(findPoints, "字符串数字", { points: "660.5" }, 660.5);
t(findPoints, "嵌套两层", { user: { profile: { points: 123 } }, email: "x" }, 123);
t(findPoints, "PointBalance 大小写", { PointBalance: 88 }, 88);
t(findPoints, "数组内", { list: [{ points: 7.2 }] }, 7.2);
t(findPoints, "无字段返回 null", { userId: 1, email: "a@b.c", leftDays: 225 }, null);
t(findPoints, "非数字不取", { points: "n/a", email: "x" }, null);
t(findPoints, "null 输入", null, null);
t(findPoints, "普通值输入", 42, null);

// ===== findEmail：宽松邮箱探测 =====
t(findEmail, "顶层 email", { email: "a@b.c", points: 1 }, "a@b.c");
t(findEmail, "嵌套 data.user", { code: 0, data: { user: { email: "x@y.z" } } }, "x@y.z");
t(findEmail, "Email 字段大小写", { Email: "Q@W.E" }, "Q@W.E");
t(findEmail, "email 字段但无 @ 跳过", { email: "n/a", name: "u", contact: { mail: "m@n.o" } }, "m@n.o");
t(findEmail, "无邮箱", { username: "user1", points: 5 }, "");
t(findEmail, "数组形态", [{ email: "p@q.r" }], "p@q.r");

// ===== findUid：用户 id 探测（官方切换接口要 {userId}）=====
t(findUid, "顶层 id", { id: 333444, email: "a@b.c" }, 333444);
t(findUid, "userId", { userId: 111222 }, 111222);
t(findUid, "嵌套 data.user", { code: 0, data: { user: { id: "999" } } }, 999);
t(findUid, "字符串数字", { user_id: "123" }, 123);
t(findUid, "无 id 字段", { email: "a@b.c", points: 5 }, null);

console.log(fail === 0 ? "=== background 纯函数单测全部通过 ===" : fail + " 处失败");
process.exit(fail === 0 ? 0 : 1);
