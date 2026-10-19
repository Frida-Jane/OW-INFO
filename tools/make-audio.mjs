// 每周简报语音播报生成工具（方案 2：预生成 MP3）
// 用法：node make-audio.mjs issues/issue-2026-01.html "海外仓市场资讯周刊，20261014 第 1 期" "欧盟€2处理费 · 旺季节点 · 品类雷达"
// 输出：audio/issue-2026-01-brief.mp3（精简版 = 本期核心 + 01 判断与行动）
//       audio/issue-2026-01-full.mp3（全文版 = 蓝区核心 + 01-08 全部正文，不含表格/悬浮说明/来源行/SVG）
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { basename, join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VOICE = "zh-CN-XiaoxiaoNeural";
const BYTES_PER_SEC = 6000; // 48kbps ≈ 6KB/s，用于时长估算

const [htmlPath, issueLine, issueTitle] = process.argv.slice(2);
if (!htmlPath) { console.error("用法: node make-audio.mjs <issue.html> <开场语> <期标题>"); process.exit(1); }

// ---------- HTML → 朗读文本 ----------
function stripNoise(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "") // SVG 图表不朗读（图注 figcaption 保留）
    .replace(/<span class="hint-pop"[\s\S]*?<\/span>/g, ""); // 悬浮说明不朗读
}
function dropBlock(html, tag, cls) {
  const re = new RegExp(`<${tag} class="[^"]*${cls}[^"]*"[\\s\\S]*?<\\/${tag}>`, "gi");
  return html.replace(re, "");
}
function htmlToText(html) {
  return html
    .replace(/<table[\s\S]*?<\/table>/gi, "") // 数据表格不朗读
    .replace(/<(h1|h2|h3|h4|li|p|div|tr|section|header|figcaption|dd|dt|br)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, "”").replace(/&#39;/g, "'")
    .split("\n").map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean).join("\n");
}
// 数字/符号朗读化
function speakize(t) {
  return t
    .replace(/(\d{4})-(\d{1,2})-(\d{1,2})/g, "$1年$2月$3日")   // ISO 日期
    .replace(/€\s?([\d.]+)/g, "$1欧元")                        // €2 → 2欧元
    .replace(/\$\s?([\d.]+)/g, "$1美元")                       // $x → x美元
    .replace(/(\d{1,2})\/(\d{1,2})(?![\d%])/g, "$1月$2日")     // 10/15 → 10月15日
    .replace(/(\d+(?:\.\d+)?)\s?-\s?(\d+(?:\.\d+)?)\s?%/g, "$1至$2%") // 11-20% → 11至20%
    .replace(/TikTok/g, "Tik Tok");
}

const raw = readFileSync(resolve(__dirname, "..", htmlPath), "utf-8");
const article = (raw.match(/<article class="page">[\s\S]*<\/article>/) || [raw])[0];
const clean = stripNoise(article);

// ---------- 分层提取（控制时长：精简≈3分钟，全文≈10分钟） ----------
function firstSent(html, max) {
  const t = htmlToText(html).replace(/\s+/g, " ");
  const m = t.match(/^[\s\S]*?[。！？；]/);
  let s = m ? m[0] : t;
  if (s.length > max) s = s.slice(0, max) + "……";
  return s;
}
// 01 判断块：h4 标题 + 编辑判断
function extractRecs(s1Html, judgeMax = null) {
  return s1Html.split(/<div class="rec">/).slice(1).map(p => {
    const block = p.split(/<\/div>/)[0]; // rec 内无嵌套 div
    const h4 = (block.match(/<h4>[\s\S]*?<\/h4>/) || [""])[0].replace(/<span class="rec-no">[\s\S]*?<\/span>/, "");
    const judge = (block.match(/<dt class="edj">[\s\S]*?<dd>([\s\S]*?)<\/dd>/) || [,""])[1];
    const jt = htmlToText(judge).replace(/\s+/g, " ");
    return htmlToText(h4) + "。" + (judgeMax && jt.length > judgeMax ? jt.slice(0, judgeMax) + "……" : jt);
  });
}
// info-card：h4 标题（超长截断）+ 正文首句
function extractCards(secHtml, maxSent, maxTitle = 20) {
  return secHtml.split(/<div class="info-card/).slice(1).map(p => {
    const block = p.split(/<\/section>/)[0];
    const h4 = htmlToText((block.match(/<h4>[\s\S]*?<\/h4>/) || [""])[0]);
    const title = h4.length > maxTitle ? h4.slice(0, maxTitle) : h4;
    const firstP = (block.match(/<p(?![^>]*class="src")[^>]*>[\s\S]*?<\/p>/) || [""])[0];
    return title + (firstP ? "。" + firstSent(firstP, maxSent) : "");
  }).filter(s => s.trim());
}
function sectionBodies() {
  return clean.split(/<section id="s/).slice(1).map(s => ({
    id: "s" + (s.match(/^(\d+)/) || ["", "?"])[1],
    body: s.split(/<\/section>/)[0],
  }));
}
function h2Text(body) {
  const h2 = (body.match(/<h2>[\s\S]*?<\/h2>/) || [""])[0];
  return htmlToText(h2.replace(/<span class="hint-pop"[\s\S]*?<\/span>/g, ""));
}

// 精简版：本期核心 5 点 + 01 各判断标题与编辑判断（总时长 >3.5 分钟则判断截 80 字）
const coreOl = (clean.match(/<ol class="pt-list"[\s\S]*?<\/ol>/) || [""])[0];
const s1 = (clean.match(/<section id="s1"[\s\S]*?<\/section>/) || [""])[0];
function buildBrief() {
  let judgeMax = null;
  let parts = [];
  for (const jm of [null, 80]) {
    judgeMax = jm;
    parts = [htmlToText(coreOl), ...extractRecs(s1, jm)];
    const chars = parts.join("").length;
    if (chars <= 800) break;
  }
  return parts.join("\n");
}
const briefText = buildBrief();

// 全文版：精简内容 + 02-07 各板块 h2 与卡片首句 + 08 表结论（超过 ~8 分钟自动收紧首句）
function buildFull() {
  let maxSent = 45;
  let parts = [];
  for (const ms of [45, 32, 22, 14]) {
    maxSent = ms;
    parts = [htmlToText(coreOl), ...extractRecs(s1, 40)];
    for (const { id, body } of sectionBodies()) {
      if (id === "s1") continue;
      parts.push(h2Text(body));
      parts.push(...extractCards(body, ms));
      if (id === "s8") {
        const tk = body.match(/<p class="table-takeaway">[\s\S]*?<\/p>/g) || [];
        parts.push(...tk.map(htmlToText));
      }
    }
    const chars = parts.join("").length;
    if (chars <= 2500) break;
  }
  return parts.join("\n");
}
const fullText = buildFull();

if (process.env.DEBUG_CHARS) {
  const stat = [];
  stat.push(["core", htmlToText(coreOl).length], ["recs", extractRecs(s1, 50).join("").length]);
  for (const { id, body } of sectionBodies()) {
    if (id === "s1") continue;
    stat.push([id, h2Text(body).length + extractCards(body, 14).join("").length
      + (id === "s8" ? ((body.match(/<p class="table-takeaway">[\s\S]*?<\/p>/g) || []).map(htmlToText).join("").length) : 0)]);
  }
  console.log("DEBUG full chars:", fullText.length, "| brief chars:", briefText.length);
  console.log("breakdown:", stat.map(([k, v]) => `${k}=${v}`).join(" "));
  process.exit(0);
}

function compose(text, isFull) {
  let out = `${issueLine}。本期主题：${issueTitle}。\n`;
  if (!isFull) out += "以下是本期核心与判断行动的精简播报。\n";
  out += speakize(text);
  if (!isFull) out += "\n以上是本期精简播报，完整数据与来源请查看网页版简报。";
  return out;
}

// ---------- TTS 合成（长文本分段合成后拼接，避免单请求超时断流） ----------
function splitText(text, maxLen = 1200) {
  const lines = text.split("\n");
  const segs = [];
  let cur = "";
  for (const line of lines) {
    if ((cur + "\n" + line).length > maxLen && cur) { segs.push(cur); cur = line; }
    else cur = cur ? cur + "\n" + line : line;
    while (cur.length > maxLen * 1.5) { // 单行超长按句号切
      const cut = cur.slice(0, maxLen).replace(/。[。！”]?[^。]*$/, "。");
      segs.push(cut); cur = cur.slice(cut.length);
    }
  }
  if (cur) segs.push(cur);
  return segs;
}
async function synth(text, outFile) {
  const segs = splitText(text);
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const chunks = [];
  for (const seg of segs) {
    const tts = new MsEdgeTTS(); // 每段独立连接，避免复用断流
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(esc(seg));
    await new Promise((ok, bad) => {
      audioStream.on("data", c => chunks.push(c));
      audioStream.on("end", ok);
      audioStream.on("error", bad);
    });
    tts.close();
  }
  const buf = Buffer.concat(chunks);
  const outPath = join(__dirname, "..", "audio", outFile);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  const min = Math.round(buf.length / BYTES_PER_SEC / 60);
  console.log(`${outFile}: ${(buf.length / 1024 / 1024).toFixed(1)}MB ≈ ${min} 分钟（${segs.length} 段）`);
}

const outBase = basename(htmlPath, ".html");
await synth(compose(briefText, false), `${outBase}-brief.mp3`);
await synth(compose(fullText, true), `${outBase}-full.mp3`);
console.log("完成");
