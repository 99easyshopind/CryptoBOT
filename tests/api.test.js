const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('HTTP controls expose paper status and reject unconfirmed live trading', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cryptobot-test-'));
    for (const item of ['server.js', 'database.js', 'config.json', 'bot', 'public'])
        fs.cpSync(path.join(__dirname, '..', item), path.join(dir, item), { recursive: true });
    fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => { child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'exit'); fs.rmSync(dir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 50; i++) {
        if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`);
        try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'server should start');
    const get = async url => (await fetch(base + url)).json();
    const post = (url, body) => fetch(base + url, {method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body)});
    const strategies = await get('/api/strategies'); assert.ok(strategies.find(s => s.id === 'master-ai'));
    let response = await post('/api/bot/start', {}); assert.equal(response.status, 400); assert.equal((await get('/api/bot/status')).running, false);
    response = await post('/api/learning/implement', {ids:['unknown']}); assert.equal(response.status, 400);
    assert.equal((await get('/api/learning')).running, false);
    response = await post('/api/learning/start', {}); assert.equal((await response.json()).running, true);
    response = await post('/api/learning/stop', {}); assert.equal((await response.json()).running, false);
    assert.equal((await fetch(base + '/')).status, 200);
});
