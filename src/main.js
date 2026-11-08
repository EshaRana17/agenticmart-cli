import readline from 'node:readline';
import { CLIENTS, applyChange, parseInstallCommand, planChange, serverName } from './config.js';

const USAGE = `usage:
  agenticmart search <query> [--type mcp|agent|skill] [--limit n] [--json]
  agenticmart info <type>/<slug> [--json]
  agenticmart install <type>/<slug> --client claude-code|cursor|vscode|windsurf [--config file] [--dry-run] [--yes]
`;

const VALUE_FLAGS = new Set(['--type', '--limit', '--client', '--config']);
const BOOL_FLAGS = new Set(['--json', '--dry-run', '--yes']);

class UsageError extends Error {}

function parse(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (argv[i + 1] === undefined) throw new UsageError(`${a} needs a value`);
      flags[a.slice(2)] = argv[(i += 1)];
    } else if (BOOL_FLAGS.has(a)) flags[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else positional.push(a);
  }
  return { flags, positional };
}

const out = (s = '') => process.stdout.write(`${s}\n`);

// API text is remote data; do not let it send terminal control codes.
export function clean(v) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

async function api(pathname) {
  const base = (process.env.AGENTICMART_API || 'https://agenticmart.org').replace(/\/+$/, '');
  const res = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (res.status === 404) throw new Error('not found on AgenticMart');
  if (!res.ok) throw new Error(`AgenticMart API returned HTTP ${res.status}`);
  return res.json();
}

function parseRef(ref) {
  const m = /^(mcp|agent|skill)\/(.+)$/.exec(ref ?? '');
  if (!m) throw new UsageError('expected <type>/<slug> where type is mcp, agent or skill');
  return { type: m[1], slug: m[2] };
}

const getListing = ({ type, slug }) => api(`/api/v1/listing/${type}/${encodeURIComponent(slug)}`);

async function search(query, flags) {
  if (!query) throw new UsageError('search needs a query');
  const params = new URLSearchParams({ q: query, limit: flags.limit ?? '10' });
  if (flags.type) params.set('type', flags.type);
  const data = await api(`/api/v1/search?${params}`);
  if (flags.json) return out(JSON.stringify(data, null, 2));
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return out('No results.');
  for (const r of results) {
    out(`${clean(r.type)}/${clean(r.slug)}  ${clean(r.name)}  stars:${clean(r.stars ?? '?')}  license:${clean(r.license ?? '?')}  scan:${clean(r.scan?.status ?? 'none')}`);
    if (r.description) out(`  ${clean(r.description).slice(0, 160)}`);
  }
  return undefined;
}

function printScan(l) {
  const s = l.scan;
  if (!s) {
    out('Scan: none on record');
    return;
  }
  out(`Scan: ${clean(s.status)}, checked ${clean(s.checkedAt ?? 'unknown')}, commit ${clean(s.commit ?? 'unknown').slice(0, 12)}, booted ${clean(s.booted ?? 'unknown')}, ${Array.isArray(s.tools) ? s.tools.length : 0} tools listed`);
  out('  A scan reports what was observed. Tools are not executed during scans.');
}

function printAdvisories(l) {
  const list = Array.isArray(l.advisories) ? l.advisories : [];
  if (!list.length) {
    out('Advisories: none on record');
    return;
  }
  out(`Advisories: ${list.length}`);
  for (const a of list) out(`  ${clean(a.id)}: ${clean(a.summary)} (fixed: ${clean(a.fixed ?? 'unknown')}) ${clean(a.url ?? '')}`);
}

async function info(ref, flags) {
  const l = await getListing(parseRef(ref));
  if (flags.json) return out(JSON.stringify(l, null, 2));
  out(`${clean(l.name)} (${clean(l.type)}/${clean(l.slug)})`);
  out(`Repo: ${clean(l.repo ?? 'unknown')}`);
  out(`License: ${clean(l.license ?? 'unknown')}`);
  out(`Page: ${clean(l.url ?? 'unknown')}`);
  out(`Install command: ${clean(l.install?.command ?? 'none listed')}`);
  printScan(l);
  if (Array.isArray(l.scan?.tools)) for (const t of l.scan.tools) out(`  - ${clean(t.name)}: ${clean(t.description).slice(0, 120)}`);
  printAdvisories(l);
  return undefined;
}

export function confirm(input, output, question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: false });
    let answered = false;
    rl.on('close', () => { if (!answered) resolve(false); });
    output.write(question);
    rl.once('line', (a) => {
      answered = true;
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

async function install(ref, flags) {
  const target = parseRef(ref);
  if (!flags.client || !Object.hasOwn(CLIENTS, flags.client)) throw new UsageError(`--client must be one of ${Object.keys(CLIENTS).join(', ')}`);
  const client = CLIENTS[flags.client];
  const l = await getListing(target);

  out(`${clean(l.name)} (${target.type}/${clean(target.slug)})`);
  out(`Install command: ${clean(l.install?.command ?? 'none listed')}`);
  printScan(l);
  printAdvisories(l);
  out();

  if (target.type !== 'mcp') {
    out('Not written: only MCP servers can be added to a client config.');
    return 1;
  }
  const parsed = parseInstallCommand(l.install?.command);
  if (parsed.refused) {
    out(`Not written: ${parsed.refused}. Review the listing and install it by hand if you want it.`);
    return 1;
  }
  const pkg = l.install?.pkg?.name;
  if (pkg && !parsed.args.some((a) => a.includes(pkg))) out(`Warning: the command does not mention the listed package ${clean(pkg)}.\n`);

  const plan = planChange({
    file: flags.config ?? client.file(),
    key: client.key,
    name: serverName(target.slug),
    entry: client.entry(parsed.command, parsed.args),
  });
  if (plan.status === 'same') {
    out(`No change: "${plan.name}" is already in ${plan.file} with these settings.`);
    return 0;
  }

  const entryText = JSON.stringify({ [plan.name]: plan.entry }, null, 2);
  out(`${flags['dry-run'] ? 'Would add' : 'Will add'} to "${plan.key}" in ${plan.file}:`);
  out(entryText);
  out(`Other server entries kept: ${plan.kept}. ${plan.exists ? 'The existing file is backed up first.' : 'The file is created.'}`);
  out('Your client will run this command when it starts the server. agenticmart does not run it.');
  if (flags['dry-run']) {
    out('Dry run: nothing was written.');
    return 0;
  }

  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write('agenticmart: refusing to write without confirmation in a non-interactive run; pass --yes to confirm.\n');
      return 2;
    }
    const ok = await confirm(process.stdin, process.stdout, 'Write this change? [y/N] ');
    if (!ok) {
      out('Nothing was written.');
      return 1;
    }
  }
  const backup = applyChange(plan);
  out(`Wrote ${plan.file}`);
  if (backup) out(`Backup: ${backup}`);
  return 0;
}

export async function main(argv) {
  try {
    const [cmd, ...rest] = argv;
    if (!cmd || cmd === '--help' || cmd === '-h') {
      out(USAGE);
      return;
    }
    const { flags, positional } = parse(rest);
    let code = 0;
    if (cmd === 'search') await search(positional.join(' '), flags);
    else if (cmd === 'info') await info(positional[0], flags);
    else if (cmd === 'install') code = await install(positional[0], flags);
    else throw new UsageError(`unknown command ${cmd}`);
    process.exitCode = code ?? 0;
  } catch (e) {
    process.stderr.write(`agenticmart: ${e.message}\n${e instanceof UsageError ? USAGE : ''}`);
    process.exitCode = 2;
  }
}
