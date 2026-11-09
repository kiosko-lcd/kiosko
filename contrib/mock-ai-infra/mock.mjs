#!/usr/bin/env node
// A pretend AI box, for trying the gpu and llm plugins without hardware.
// It serves, on 127.0.0.1:
//   :19400/metrics   DCGM exporter: two GPUs (RTX 4090 + RTX 3090)
//   :18000           vLLM (Llama-3.1-8B on GPU 0): /metrics /v1/models /version
//   :18080           llama.cpp (gemma-3-27b on GPU 1): /health /props /slots /metrics
//   :11435           Ollama (on GPU 1): /api/version /api/ps /api/tags
// Load comes in bursts (a few minutes busy, a few quiet) and the GPUs heat up
// and cool down with it, so widgets go from dark to busy to alarming.
//   node mock.mjs [--hot]     --hot keeps everything near its limits
import { createServer } from 'node:http';

const hot = process.argv.includes('--hot');
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const rnd = (a, b) => a + Math.random() * (b - a);

// ---- load model: per engine, a 0..1 level following bursts ----
function burst(period, duty, phase) {
  return () => {
    if (hot) return 0.95;
    const x = ((now() + phase) % period) / period;
    if (x > duty) return 0;
    return Math.min(1, Math.sin((x / duty) * Math.PI) * 1.4) * rnd(0.85, 1);
  };
}
const load = { vllm: burst(300, 0.6, 0), llama: burst(420, 0.35, 140), ollama: burst(240, 0.25, 60) };

// ---- counters (integrate rates every second) ----
const c = { vPrompt: 4.8e6, vGen: 1.2e6, vReq: 9300, lPrompt: 18432, lPromptS: 21, lGen: 9120, lGenS: 240, ttft: [] };
const TTFT_LE = [0.001, 0.02, 0.1, 0.25, 0.5, 1, 2.5];
const ttftBuckets = new Array(TTFT_LE.length).fill(0); let ttftCount = 0, ttftSum = 0;
const gpu = [
  { name: 'NVIDIA GeForce RTX 4090', uuid: 'GPU-4b1d6e2a-0f3c-4c51-9a7e-1d2f3a4b5c60', mem: 24564, idleW: 22, maxW: 450, temp: 38, base: 2800 },
  { name: 'NVIDIA GeForce RTX 3090', uuid: 'GPU-9c8e7d6f-1a2b-4c3d-8e9f-0a1b2c3d4e5f', mem: 24576, idleW: 28, maxW: 350, temp: 40, base: 1300 },
];
setInterval(() => {
  const v = load.vllm(), l = load.llama(), o = load.ollama();
  const vGen = v * rnd(70, 95) * (1 + v * 2), vPrompt = v * rnd(300, 900);
  c.vGen += vGen; c.vPrompt += vPrompt;
  if (v > 0) {
    const n = Math.round(v * 3); c.vReq += n;
    for (let i = 0; i < n; i++) {
      const t = (hot ? 0.9 : 0.12) * rnd(0.5, 3); ttftCount++; ttftSum += t;
      TTFT_LE.forEach((le, j) => { if (t <= le) ttftBuckets[j]++; });
    }
  }
  if (l > 0) { c.lGen += l * rnd(30, 40); c.lGenS += l; c.lPrompt += l * rnd(400, 900); c.lPromptS += l * 0.5; }
  const util = [Math.min(1, v * 1.05), Math.min(1, l + o * 0.9)];
  gpu.forEach((g, i) => {
    g.util = util[i];
    g.power = g.idleW + (g.maxW - g.idleW) * util[i] * rnd(0.9, 1);
    const target = 36 + util[i] * (hot ? 54 : 44);
    g.temp += (target - g.temp) * 0.04 + rnd(-0.2, 0.2);
  });
}, 1000);

// ---- Prometheus helpers ----
const line = (name, labels, v) => `${name}{${Object.entries(labels).map(([k, x]) => `${k}="${x}"`).join(',')}} ${v}`;
const text = (res, body, type = 'text/plain; version=0.0.4') => { res.writeHead(200, { 'content-type': type }); res.end(body + '\n'); };
const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const notFound = (res) => { res.writeHead(404); res.end('not found'); };
const serve = (port, routes) => createServer((req, res) => { const f = routes[req.url.split('?')[0]]; f ? f(res) : notFound(res); }).listen(port, '127.0.0.1');

// ---- DCGM exporter ----
const used = () => [Math.round(17800 + load.vllm() * 4200), Math.round(19400 + (load.llama() > 0 ? 1600 : 0) + load.ollama() * 900)];
serve(19400, {
  '/metrics': (res) => {
    const u = used(), out = [];
    const m = (n, help, f) => { out.push(`# HELP ${n} ${help}`, `# TYPE ${n} gauge`); gpu.forEach((g, i) => out.push(line(n, { gpu: i, UUID: g.uuid, device: `nvidia${i}`, modelName: g.name, Hostname: 'gpubox' }, f(g, i)))); };
    m('DCGM_FI_DEV_GPU_TEMP', 'GPU temperature (in C).', (g) => g.temp.toFixed(0));
    m('DCGM_FI_DEV_MEMORY_TEMP', 'Memory temperature (in C).', (g) => (g.temp + 8 + g.util * 10).toFixed(0));
    m('DCGM_FI_DEV_GPU_UTIL', 'GPU utilization (in %).', (g) => Math.round(g.util * 100));
    m('DCGM_FI_DEV_FB_USED', 'Framebuffer memory used (in MiB).', (g, i) => u[i]);
    m('DCGM_FI_DEV_FB_FREE', 'Framebuffer memory free (in MiB).', (g, i) => g.mem - u[i]);
    m('DCGM_FI_DEV_POWER_USAGE', 'Power draw (in W).', (g) => g.power.toFixed(1));
    m('DCGM_FI_DEV_POWER_MGMT_LIMIT', 'Power management limit (in W).', (g) => g.maxW);
    m('DCGM_FI_DEV_SM_CLOCK', 'SM clock frequency (in MHz).', (g) => Math.round(g.util > 0 ? g.base * rnd(0.95, 1) : 210));
    m('DCGM_FI_DEV_MEM_CLOCK', 'Memory clock frequency (in MHz).', (g) => (g.util > 0 ? 10501 : 405));
    text(res, out.join('\n'));
  },
});

// ---- vLLM ----
const VM = 'meta-llama/Llama-3.1-8B-Instruct', vl = { engine: '0', model_name: VM };
serve(18000, {
  '/version': (res) => json(res, { version: '0.11.0' }),
  '/v1/models': (res) => json(res, { object: 'list', data: [{ id: VM, object: 'model', owned_by: 'vllm', max_model_len: 32768 }] }),
  '/metrics': (res) => {
    const v = load.vllm(), running = Math.round(v * 4), waiting = hot ? 5 : v > 0.9 ? Math.round(rnd(0, 3)) : 0;
    const out = [
      '# TYPE vllm:num_requests_running gauge', line('vllm:num_requests_running', vl, running),
      '# TYPE vllm:num_requests_waiting gauge', line('vllm:num_requests_waiting', vl, waiting),
      '# TYPE vllm:kv_cache_usage_perc gauge', line('vllm:kv_cache_usage_perc', vl, (hot ? 0.95 : v * rnd(0.3, 0.8)).toFixed(4)),
      '# TYPE vllm:prompt_tokens_total counter', line('vllm:prompt_tokens_total', vl, Math.round(c.vPrompt)),
      '# TYPE vllm:generation_tokens_total counter', line('vllm:generation_tokens_total', vl, Math.round(c.vGen)),
      '# TYPE vllm:request_success_total counter', line('vllm:request_success_total', { ...vl, finished_reason: 'stop' }, c.vReq),
      '# TYPE vllm:time_to_first_token_seconds histogram',
      ...TTFT_LE.map((le, j) => line('vllm:time_to_first_token_seconds_bucket', { engine: '0', le, model_name: VM }, ttftBuckets[j])),
      line('vllm:time_to_first_token_seconds_bucket', { engine: '0', le: '+Inf', model_name: VM }, ttftCount),
      line('vllm:time_to_first_token_seconds_count', vl, ttftCount), line('vllm:time_to_first_token_seconds_sum', vl, ttftSum.toFixed(3)),
    ];
    text(res, out.join('\n'));
  },
});

// ---- llama.cpp ----
const LM = 'gemma-3-27b-it-Q4_K_M.gguf';
serve(18080, {
  '/health': (res) => json(res, { status: 'ok' }),
  '/props': (res) => json(res, { model_path: `/models/${LM}`, total_slots: 2, default_generation_settings: { n_ctx: 16384 }, build_info: 'b6200' }),
  '/slots': (res) => { const busy = load.llama() > 0; json(res, [0, 1].map((id) => ({ id, n_ctx: 8192, is_processing: busy && id === 0, next_token: [{ n_decoded: busy && id === 0 ? Math.round(now() % 600) : 0 }] }))); },
  '/metrics': (res) => {
    const l = load.llama();
    text(res, [
      '# TYPE llamacpp:prompt_tokens_total counter', `llamacpp:prompt_tokens_total ${Math.round(c.lPrompt)}`,
      `llamacpp:prompt_seconds_total ${c.lPromptS.toFixed(2)}`,
      '# TYPE llamacpp:tokens_predicted_total counter', `llamacpp:tokens_predicted_total ${Math.round(c.lGen)}`,
      `llamacpp:tokens_predicted_seconds_total ${c.lGenS.toFixed(2)}`,
      `llamacpp:prompt_tokens_seconds ${l > 0 ? rnd(700, 900).toFixed(1) : 0}`,
      `llamacpp:predicted_tokens_seconds ${l > 0 ? rnd(32, 40).toFixed(2) : 0}`,
      `llamacpp:kv_cache_usage_ratio ${(l * 0.4).toFixed(3)}`,
      `llamacpp:requests_processing ${l > 0 ? 1 : 0}`, `llamacpp:requests_deferred 0`,
    ].join('\n'));
  },
});

// ---- Ollama (on a non-default port so a real one on 11434 isn't shadowed) ----
const GB = 1024 ** 3;
serve(11435, {
  '/api/version': (res) => json(res, { version: '0.12.6' }),
  '/api/tags': (res) => json(res, { models: ['qwen2.5-coder:32b', 'llama3.2:3b', 'nomic-embed-text:latest', 'deepseek-r1:14b'].map((name) => ({ name, model: name, size: 4 * GB })) }),
  '/api/ps': (res) => {
    const models = [{ name: 'nomic-embed-text:latest', size: 0.6 * GB, vram: 0.6 * GB, ctx: 8192, q: 'F16', exp: '2318-02-21T00:00:00Z' }];
    // The coder model stays loaded 5 min after its last burst (keep-alive).
    const sinceBurst = (now() + 60) % 240;
    if (load.ollama() > 0 || sinceBurst < 60 + 300) models.unshift({ name: 'qwen2.5-coder:32b', size: 21.7 * GB, vram: 21.7 * GB, ctx: 32768, q: 'Q4_K_M', exp: new Date(Date.now() + Math.max(0, (360 - sinceBurst)) * 1000).toISOString() });
    json(res, { models: models.map((m) => ({ name: m.name, model: m.name, size: Math.round(m.size), size_vram: Math.round(m.vram), context_length: m.ctx, expires_at: m.exp, details: { quantization_level: m.q, format: 'gguf' } })) });
  },
});

console.log(`mock AI box${hot ? ' (hot)' : ''}: dcgm :19400  vllm :18000  llama.cpp :18080  ollama :11435`);
