import express from 'express';
import { spawn } from 'node:child_process';

const upstream = express();
upstream.use(express.json());
const seen = [];
upstream.all('*path', (req, res) => {
    seen.push({ path: req.path, query: req.query, headers: req.headers, body: req.body });
    if (req.path === '/assistant-script.json') return res.json({ type: 'script', name: 'URL 测试脚本', enabled: false, content: 'globalThis.__urlScriptLoaded = true;' });
    if (req.path.endsWith('/models')) return res.json(req.path.includes('v1beta') ? { models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }] } : { data: [{ id: 'test-model' }] });
    if (req.path.endsWith('/messages')) return res.json({ content: [{ type: 'text', text: 'anthropic-ok' }] });
    if (req.path.endsWith('/responses')) return res.json({ output_text: 'responses-ok' });
    if (req.path.includes(':generateContent')) return res.json({ candidates: [{ content: { parts: [{ text: 'gemini-ok' }] } }] });
    if (req.path.endsWith('/chat/completions')) {
        res.type('text/event-stream');
        return res.end('data: {"choices":[{"delta":{"content":"openai-ok"}}]}\n\ndata: [DONE]\n\n');
    }
    res.status(404).json({ error: 'unknown mock route' });
});
const upstreamServer = upstream.listen(4281, '127.0.0.1');
const child = spawn(process.execPath, ['server.js', '--api-only'], { cwd: new URL('..', import.meta.url), env: { ...process.env, REINCARNATION_PORT: '4280' }, stdio: 'ignore' });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    await wait(1000);
    const base = { baseUrl: 'http://127.0.0.1:4281', apiKey: 'test-key', model: 'test-model', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }] };
    const output = {};
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini']) {
        const response = await fetch('http://127.0.0.1:4280/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, protocol }) });
        output[protocol] = { status: response.status, body: await response.text() };
    }
    for (const protocol of ['openai-chat', 'anthropic', 'gemini']) {
        const response = await fetch('http://127.0.0.1:4280/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, protocol }) });
        output[`${protocol}-models`] = { status: response.status, body: await response.text() };
    }
    const scriptResponse = await fetch('http://127.0.0.1:4280/api/import-script-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:4281/assistant-script.json' }) });
    output['script-url-import'] = { status: scriptResponse.status, body: await scriptResponse.text() };
    console.log(JSON.stringify({ output, paths: seen.map(item => item.path) }, null, 2));
    if (Object.values(output).some(item => item.status !== 200) || !seen.some(item => item.path.endsWith('/responses')) || !seen.some(item => item.path.endsWith('/messages')) || !seen.some(item => item.path.includes(':generateContent'))) process.exitCode = 1;
} finally {
    child.kill();
    upstreamServer.close();
}
