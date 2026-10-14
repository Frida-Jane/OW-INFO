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

// 精简版：本期核心（蓝区 pt-list）+ 01 判断与行动
const coreOl = (clean.match(/<ol class="pt-list"[\s\S]*?<\/ol>/) || [""])[0];
const s1 = (clean.match(/<section id="s1"[\s\S]*?<\/section>/) || [""])[0];
const briefText = [coreOl, s1].map(htmlToText).join("\n");

// 全文版：article 全部（表格/悬浮/来源行已在 htmlToText 中剔除）
const fullText = htmlToText(clean);

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
