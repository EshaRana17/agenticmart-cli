import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { confirm, clean } from '../src/main.js';
import { parseInstallCommand } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'agenticmart.js');
const MARKER = path.join(os.tmpdir(), `agenticmart-must-not-exist-${process.pid}`);

const listing = (over = {}) => ({
  name: 'Good Server', slug: 'good', type: 'mcp', repo: 'https://github.com/a/good', url: 'https://agenticmart.org/mcp/good', license: 'MIT',
  install: { command: 'npx -y good-server', pkg: { name: 'good-server', ecosystem: 'npm' } },
  scan: { status: 'booted', commit: 'abcdef0123456789', checkedAt: '2026-11-01T00:00:00Z', tools: [{ name: 'read', description: 'Reads' }], hosts: [], booted: true },
  advisories: [],
  ...over,
});
const LISTINGS = {
  '/api/v1/listing/mcp/good': listing(),
  '/api/v1/listing/mcp/vuln': listing({ advisories: [{ id: 'GHSA-1', summary: 'Bad bug', fixed: '1.2.3', url: 'https://example.test/a' }] }),
  '/api/v1/listing/mcp/noscan': listing({ scan: null }),
  '/api/v1/listing/mcp/docker': listing({ install: { command: 'docker run evil', pkg: null } }),
  '/api/v1/listing/mcp/none': listing({ install: { command: null, pkg: null } }),
  '/api/v1/listing/mcp/shell': listing({ install: { command: `npx good; node -e "require('fs').writeFileSync('${MARKER.replace(/\\/g, '/')}','x')"`, pkg: null } }),
  '/api/v1/listing/mcp/uv': listing({ install: { command: 'uvx mcp-thing --flag "two words"', pkg: { name: 'mcp-thing', ecosystem: 'pypi' } } }),
  '/api/v1/listing/skill/sk': listing({ type: 'skill' }),
  '/api/v1/listing/mcp/__proto__': listing(),
};

let server;
let api;
let lastUrl;
before(async () => {
  server = http.createServer((req, res) => {
    lastUrl = req.url;
    if (req.url.startsWith('/api/v1/search')) {
      res.end(JSON.stringify({ results: [{ name: 'Good Server', slug: 'good', type: 'mcp', repo: 'r', description: 'A good one\u001b[31m', stars: 5, license: 'MIT', url: 'u', scan: { status: 'booted', checkedAt: 'x' } }] }));
      return;
    }
    const decoded = decodeURIComponent(req.url);
    if (LISTINGS[decoded]) { res.end(JSON.stringify(LISTINGS[decoded])); return; }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  api = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  return { dir, home: path.join(dir, 'home'), cwd: path.join(dir, 'proj') };
}

function run(args, ws = workspace()) {
  fs.mkdirSync(ws.home, { recursive: true });
  fs.mkdirSync(ws.cwd, { recursive: true });
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd: ws.cwd, env: { ...process.env, AGENTICMART_API: api, HOME: ws.home, USERPROFILE: ws.home }, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.end();
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr, ws }));
  });
}

const backups = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.agenticmart-backup-'));

test('search prints results and strips terminal control codes', async () => {
  const r = await run(['search', 'good', 'stuff', '--type', 'mcp', '--limit', '3']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mcp\/good/);
  assert.equal(r.stdout.includes('\u001b'), false);
  assert.match(lastUrl, /q=good\+stuff&limit=3&type=mcp/);
});

test('info shows listing, scan and advisories', async () => {
  const r = await run(['info', 'mcp/vuln']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Scan: booted/);
  assert.match(r.stdout, /GHSA-1: Bad bug/);
});

test('info reports a missing listing', async () => {
  const r = await run(['info', 'mcp/absent']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not found/);
});

test('bad reference is a usage error', async () => {
  assert.equal((await run(['info', 'nope'])).code, 2);
});

test('non-interactive install without --yes refuses and writes nothing', async () => {
  const r = await run(['install', 'mcp/good', '--client', 'claude-code']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /non-interactive/);
  assert.equal(fs.existsSync(path.join(r.ws.cwd, '.mcp.json')), false);
});

test('dry run prints the change and writes nothing', async () => {
  const r = await run(['install', 'mcp/good', '--client', 'claude-code', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Would add/);
  assert.match(r.stdout, /"command": "npx"/);
  assert.match(r.stdout, /nothing was written/);
  assert.equal(fs.existsSync(path.join(r.ws.cwd, '.mcp.json')), false);
});

test('claude-code writes .mcp.json in the project', async () => {
  const r = await run(['install', 'mcp/good', '--client', 'claude-code', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.ws.cwd, '.mcp.json'), 'utf8')), { mcpServers: { good: { command: 'npx', args: ['-y', 'good-server'] } } });
});

test('cursor writes the home config with type stdio', async () => {
  const r = await run(['install', 'mcp/good', '--client', 'cursor', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.ws.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.good, { type: 'stdio', command: 'npx', args: ['-y', 'good-server'] });
});

test('vscode writes .vscode/mcp.json under "servers"', async () => {
  const r = await run(['install', 'mcp/good', '--client', 'vscode', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.ws.cwd, '.vscode', 'mcp.json'), 'utf8')).servers.good, { type: 'stdio', command: 'npx', args: ['-y', 'good-server'] });
});

test('windsurf writes its mcp_config.json', async () => {
  const r = await run(['install', 'mcp/uv', '--client', 'windsurf', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.ws.home, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8')).mcpServers.uv, { command: 'uvx', args: ['mcp-thing', '--flag', 'two words'] });
});

test('merge keeps other entries and keys, and backs up the original', async () => {
  const ws = workspace();
  fs.mkdirSync(ws.cwd, { recursive: true });
  const file = path.join(ws.cwd, '.mcp.json');
  const original = JSON.stringify({ other: true, mcpServers: { mine: { command: 'node', args: ['x'] } } });
  fs.writeFileSync(file, original);
  const r = await run(['install', 'mcp/good', '--client', 'claude-code', '--yes'], ws);
  assert.equal(r.code, 0, r.stderr);
  const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(merged.other, true);
  assert.deepEqual(merged.mcpServers.mine, { command: 'node', args: ['x'] });
  assert.ok(merged.mcpServers.good);
  const b = backups(file);
  assert.equal(b.length, 1);
  assert.equal(fs.readFileSync(path.join(ws.cwd, b[0]), 'utf8'), original);
});

test('an existing entry with the same name is never overwritten', async () => {
  const ws = workspace();
  fs.mkdirSync(ws.cwd, { recursive: true });
  const file = path.join(ws.cwd, '.mcp.json');
  const original = JSON.stringify({ mcpServers: { good: { command: 'node', args: ['mine'] } } });
  fs.writeFileSync(file, original);
  const r = await run(['install', 'mcp/good', '--client', 'claude-code', '--yes'], ws);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /already exists/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('running the same install twice changes nothing', async () => {
  const ws = workspace();
  await run(['install', 'mcp/good', '--client', 'claude-code', '--yes'], ws);
  const r = await run(['install', 'mcp/good', '--client', 'claude-code', '--yes'], ws);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No change/);
  assert.equal(backups(path.join(ws.cwd, '.mcp.json')).length, 0);
});

test('a config that is not plain JSON is left alone', async () => {
  const ws = workspace();
  fs.mkdirSync(path.join(ws.cwd, '.vscode'), { recursive: true });
  const file = path.join(ws.cwd, '.vscode', 'mcp.json');
  const original = '// comment\n{"servers":{}}';
  fs.writeFileSync(file, original);
  const r = await run(['install', 'mcp/good', '--client', 'vscode', '--yes'], ws);
  assert.equal(r.code, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('--config overrides the path', async () => {
  const ws = workspace();
  fs.mkdirSync(ws.dir, { recursive: true });
  const custom = path.join(ws.dir, 'custom.json');
  const r = await run(['install', 'mcp/good', '--client', 'windsurf', '--yes', '--config', custom], ws);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(JSON.parse(fs.readFileSync(custom, 'utf8')).mcpServers.good);
});

test('advisories and missing scans are shown before any change', async () => {
  const a = await run(['install', 'mcp/vuln', '--client', 'claude-code', '--dry-run']);
  assert.match(a.stdout, /GHSA-1/);
  const b = await run(['install', 'mcp/noscan', '--client', 'claude-code', '--dry-run']);
  assert.match(b.stdout, /Scan: none on record/);
});

for (const slug of ['docker', 'none', 'shell']) {
  test(`install does not write a config for mcp/${slug}`, async () => {
    const r = await run(['install', `mcp/${slug}`, '--client', 'claude-code', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Not written/);
    assert.equal(fs.existsSync(path.join(r.ws.cwd, '.mcp.json')), false);
    assert.equal(fs.existsSync(MARKER), false, 'install command must never run');
  });
}

test('only MCP listings can be written', async () => {
  const r = await run(['install', 'skill/sk', '--client', 'cursor', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /only MCP servers/);
});

test('a reserved server name is refused', async () => {
  const r = await run(['install', 'mcp/__proto__', '--client', 'claude-code', '--yes']);
  assert.equal(r.code, 2);
});

test('unknown client is a usage error', async () => {
  assert.equal((await run(['install', 'mcp/good', '--client', 'emacs', '--yes'])).code, 2);
});

test('parseInstallCommand refuses shell syntax and shell-running npx flags', () => {
  assert.ok(parseInstallCommand('npx a && b').refused);
  assert.ok(parseInstallCommand('npx -c "evil"').refused);
  assert.ok(parseInstallCommand('npx --call=evil').refused);
  assert.ok(parseInstallCommand('curl x').refused);
  assert.ok(parseInstallCommand('npx "unterminated').refused);
  assert.deepEqual(parseInstallCommand('npx -y pkg@1.0'), { command: 'npx', args: ['-y', 'pkg@1.0'] });
});

test('confirm accepts only y or yes, and treats EOF as no', async () => {
  const ask = async (text) => {
    const input = new PassThrough();
    const p = confirm(input, new PassThrough(), '? ');
    input.end(text);
    return p;
  };
  assert.equal(await ask('y\n'), true);
  assert.equal(await ask('YES\n'), true);
  assert.equal(await ask('n\n'), false);
  assert.equal(await ask('\n'), false);
  assert.equal(await ask(''), false);
});

test('clean removes control characters', () => {
  assert.equal(clean('a\u001b[2Jb\nc'), 'a [2Jb c');
});
