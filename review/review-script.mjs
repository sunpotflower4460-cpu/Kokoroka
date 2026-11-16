#!/usr/bin/env node
// こころか 台本自動添削
// 使い方: node review/review-script.mjs episodes/<ep>/script.md
// - ルールチェック（決定的）: 断定表現、出典漏れ、尺見積もり、フックの有無
// - モデルレビュー（OPENAI_API_KEY がある場合）: SNS-AI と同じ発想のスコアリング
// 結果は episodes/<ep>/review.md と review.json に書く。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: review-script.mjs <script.md>");
  process.exit(2);
}
const text = readFileSync(file, "utf8");
const dir = dirname(file);

function section(name) {
  const m = text.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return m ? m[1].trim() : "";
}
const narration = section("ナレーション");
const meta = section("メタ");

// --- ルールチェック ---
const warnings = [];
const errors = [];

// 健康・癒しの断定表現（行単位で検出）
const ASSERTIVE = ["治ります", "治る", "効きます", "効果があります", "必ず", "絶対に", "改善します", "予防できます", "若返"];
narration.split("\n").forEach((line, i) => {
  for (const w of ASSERTIVE) {
    if (line.includes(w)) {
      warnings.push(`断定表現の疑い: ナレーション${i + 1}行目「${w}」—「〜という研究がある」等の形にできないか確認`);
    }
  }
});

// 出典チェック: 研究・生態の主張があるのに出典が空なら警告
const sourceLine = (meta.match(/出典[:：]\s*(.*)/) || [])[1] || "";
if (/研究|論文|生態|実験/.test(narration) && sourceLine.trim().length < 4) {
  errors.push("出典が未記入なのに研究・生態系の主張が含まれている");
}
if (!sourceLine.trim()) {
  warnings.push("メタの出典が空（主張がない回の場合は問題なし）");
}

// 尺見積もり: 日本語ナレーション約350字/分
const chars = narration.replace(/\s/g, "").length;
const estSec = Math.round((chars / 350) * 60);
if (chars === 0) errors.push("ナレーションが空");
if (estSec > 240) warnings.push(`尺が長め（推定 ${estSec} 秒 / ${chars} 字）`);

// フック: ナレーション冒頭2文の存在
const firstLines = narration.split("\n").filter((l) => l.trim()).slice(0, 2).join("");
if (firstLines.length < 10) warnings.push("冒頭のフックが弱い可能性（最初の2行が短い）");

// --- モデルレビュー ---
let modelReview = null;
const apiKey = process.env.OPENAI_API_KEY;
if (apiKey) {
  const model = process.env.KOKOROKA_REVIEW_MODEL || "gpt-6-luna";
  const prompt = `あなたはメディア「こころか」（テーマ: 自然と人間の共生）の台本添削者です。
以下の台本を読み、JSONだけで返してください。
{
  "naturalness": 0-100（AIっぽくない自然な文章か）,
  "aiPatternRisk": 0-100（AI特有の型にはまった表現の多さ。低いほど良い）,
  "worldFit": 0-100（「自然と人間の共生」の世界観と温かさに合っているか）,
  "hookScore": 0-100（冒頭3秒で続きを見たくなるか）,
  "comments": ["具体的な改善提案を最大5件、行や表現を指して"],
  "summary": "総評を1文で"
}

台本:
${text}`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      modelReview = { model, ...JSON.parse(data.choices[0].message.content) };
    } else {
      warnings.push(`モデルレビュー失敗: HTTP ${res.status}`);
    }
  } catch (e) {
    warnings.push(`モデルレビュー失敗: ${e.message}`);
  }
} else {
  warnings.push("OPENAI_API_KEY 未設定のためモデルレビューをスキップ（ルールチェックのみ）");
}

const result = {
  file,
  reviewedAt: new Date().toISOString(),
  narrationChars: chars,
  estimatedSeconds: estSec,
  errors,
  warnings,
  modelReview,
};
writeFileSync(join(dir, "review.json"), JSON.stringify(result, null, 2) + "\n");

const md = [
  `# 自動添削結果`,
  ``,
  `- 対象: ${file}`,
  `- ナレーション: ${chars} 字（推定 ${estSec} 秒）`,
  modelReview
    ? `- スコア: naturalness ${modelReview.naturalness} / aiPatternRisk ${modelReview.aiPatternRisk} / worldFit ${modelReview.worldFit} / hookScore ${modelReview.hookScore}（${modelReview.model}）`
    : `- スコア: モデルレビューなし`,
  modelReview ? `- 総評: ${modelReview.summary}` : ``,
  ``,
  `## エラー`,
  ...(errors.length ? errors.map((e) => `- ${e}`) : ["- なし"]),
  ``,
  `## 警告`,
  ...(warnings.length ? warnings.map((w) => `- ${w}`) : ["- なし"]),
  ``,
  `## 改善提案`,
  ...(modelReview?.comments?.length ? modelReview.comments.map((c) => `- ${c}`) : ["- なし"]),
  ``,
].join("\n");
writeFileSync(join(dir, "review.md"), md);
console.log(md);
if (errors.length && process.argv.includes("--strict")) process.exit(1);
