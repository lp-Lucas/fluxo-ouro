import fs from "node:fs";
const env = fs.readFileSync(".env","utf8");
const key = (env.match(/^OPENAI_API_KEY=(.+)$/m)?.[1] ?? "").trim();
const model = (env.match(/^OPENAI_CHAT_MODEL=(.+)$/m)?.[1] ?? "gpt-5").trim();
console.log("chat model do .env:", model);
const r = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, input: [{ role: "user", content: [{ type: "input_text", text: "a red circle, flat" }] }], tools: [{ type: "image_generation", size: "1024x1536", quality: "high" }], tool_choice: { type: "image_generation" } }),
});
const txt = await r.text();
console.log("HTTP", r.status);
console.log(txt.slice(0, 500));
