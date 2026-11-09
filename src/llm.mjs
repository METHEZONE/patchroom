// OpenAI-compatible chat client. Default target: the local subscription gateway.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PATCHROOM_LLM_BASE || 'http://127.0.0.1:8787/v1';
const MODELS = (process.env.PATCHROOM_MODELS || 'claude-sonnet-5-5,gpt-6.1-sol').split(',').map((s) => s.trim()).filter(Boolean);

function token() {
  if (process.env.PATCHROOM_LLM_TOKEN) return process.env.PATCHROOM_LLM_TOKEN;
  try {
    return fs.readFileSync(path.join(os.homedir(), '.ai-gateway', 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function headers() {
  const t = token();
  return {
    'content-type': 'application/json',
    'x-ai-gateway-token': t,
    authorization: `Bearer ${t}`,
  };
}

/**
 * Stream a chat completion. Calls onDelta(text) for each chunk; resolves with the full text.
 * Falls back across PATCHROOM_MODELS on HTTP errors.
 */
export async function chat(messages, { onDelta = () => {}, maxTokens = 4000 } = {}) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        lastErr = new Error(`${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        continue;
      }
      let full = '';
      let buf = '';
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const d = j.choices?.[0]?.delta?.content;
            if (d) {
              full += d;
              onDelta(d);
            }
          } catch {}
        }
      }
      if (!full) {
        lastErr = new Error(`${model}: empty response`);
        continue;
      }
      return { text: full, model };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no model available');
}

export function extractCode(text) {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return m ? m[1] : text;
}

export const llmInfo = { base: BASE, models: MODELS };
