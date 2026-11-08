import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Paths and formats come from each client's official docs; see the README.
export const CLIENTS = {
  'claude-code': {
    file: () => path.join(process.cwd(), '.mcp.json'),
    key: 'mcpServers',
    entry: (command, args) => ({ command, args }),
  },
  cursor: {
    file: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
    key: 'mcpServers',
    entry: (command, args) => ({ type: 'stdio', command, args }),
  },
  vscode: {
    file: () => path.join(process.cwd(), '.vscode', 'mcp.json'),
    key: 'servers',
    entry: (command, args) => ({ type: 'stdio', command, args }),
  },
  windsurf: {
    file: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    key: 'mcpServers',
    entry: (command, args) => ({ command, args }),
  },
};

const RUNNERS = new Set(['npx', 'uvx']);
const SHELL_META = /[;&|<>`$()\r\n]/;
const NPX_SHELL_FLAGS = new Set(['-c', '--call']);

function tokenize(text) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(cur);
  return out;
}

// Returns {command, args} or {refused: reason}. Only plain npx or uvx commands qualify.
export function parseInstallCommand(text) {
  if (typeof text !== 'string' || !text.trim()) return { refused: 'this listing has no install command' };
  if (SHELL_META.test(text)) return { refused: 'the install command contains shell syntax' };
  const tokens = tokenize(text);
  if (!tokens || tokens.length < 2) return { refused: 'the install command could not be parsed' };
  const [command, ...args] = tokens;
  if (!RUNNERS.has(command)) return { refused: `only npx and uvx commands can be written to a client config, this one starts with "${command}"` };
  if (command === 'npx' && args.some((a) => NPX_SHELL_FLAGS.has(a) || a.startsWith('--call='))) {
    return { refused: 'the install command uses an npx flag that runs a shell string' };
  }
  return { command, args };
}

export function serverName(slug) {
  const name = slug.replace(/[^A-Za-z0-9._@-]/g, '-');
  if (['__proto__', 'constructor', 'prototype'].includes(name) || !name) throw new Error(`cannot use "${slug}" as a server name`);
  return name;
}

function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, config: {} };
    throw e;
  }
  if (!text.trim()) return { exists: true, config: {} };
  let config;
  try {
    config = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`${file} is not plain JSON, so it was left unchanged (${e.message}). Add the entry by hand.`);
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error(`${file} is not a JSON object, so it was left unchanged`);
  return { exists: true, config };
}

// Works out the change without touching disk.
export function planChange({ file, key, name, entry }) {
  const { exists, config } = readConfig(file);
  const servers = config[key] ?? {};
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) throw new Error(`"${key}" in ${file} is not an object, so it was left unchanged`);
  const existing = Object.hasOwn(servers, name) ? servers[name] : undefined;
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(entry)) return { file, key, name, entry, exists, status: 'same' };
    throw new Error(`"${name}" already exists in ${file} with different settings. It was left unchanged; remove it first or edit it by hand.`);
  }
  servers[name] = entry;
  config[key] = servers;
  return { file, key, name, entry, exists, status: 'add', kept: Object.keys(servers).length - 1, merged: config };
}

export function applyChange(plan) {
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  let backup = null;
  let mode;
  if (plan.exists) {
    backup = `${plan.file}.agenticmart-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(plan.file, backup, fs.constants.COPYFILE_EXCL);
    mode = fs.statSync(plan.file).mode;
  }
  const tmp = `${plan.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(plan.merged, null, 2)}\n`, mode === undefined ? {} : { mode });
  fs.renameSync(tmp, plan.file);
  return backup;
}
