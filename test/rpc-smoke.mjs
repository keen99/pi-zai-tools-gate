#!/usr/bin/env node
// Deep pinned-pi smoke for zai-tools-gate. Boots real pi in RPC mode with
// the extension loaded (ZAI_GATE_DEBUG=1). The session_start marker records
// the active provider, its image capability, and the post-gate active tool
// list on the real process. Gate matrix (allow/deny, vision keep, config
// precedence) is covered by unit tests with an injectable config.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'pi-zai-gate-deep-'));
const agentDir = join(dir, 'agent');
mkdirSync(join(agentDir, 'sessions', 'tmp'), { recursive: true });
const MARKER = join(agentDir, 'zai-gate-loaded.json');

const child = spawn(
	process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
	['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '--session-dir', join(agentDir, 'sessions', 'tmp')],
	{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ZAI_GATE_DEBUG: '1' }, cwd: dir },
);
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

const t0 = Date.now();
const killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000);
const poll = setInterval(() => {
	if (existsSync(MARKER)) {
		clearInterval(poll);
		finish(true);
	} else if (Date.now() - t0 > 20_000) {
		clearInterval(poll);
		finish(false);
	}
}, 200);

function finish(ok) {
	child.kill('SIGTERM');
	child.on('exit', () => {
		clearTimeout(killTimer);
		try {
			assert2(ok, `timed out; stderr tail: ${err.slice(-800)}`);
			const m = JSON.parse(readFileSync(MARKER, 'utf8'));
			assert2(m.loaded === true, `loaded flag: ${JSON.stringify(m)}`);
			assert2(Array.isArray(m.active), `active tool list recorded: ${JSON.stringify(m)}`);
			console.log(`Deep smoke PASS: real pi loaded zai-tools-gate; provider=${m.provider} activeTools=${m.active.length} (${(Date.now() - t0) / 1000 | 0}s).`);
		} catch (e) {
			console.error('FAIL', e.message);
			console.error(`stdout tail: ${out.slice(-400)}`);
			process.exitCode = 1;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
function assert2(cond, msg) { if (!cond) throw new Error(msg); }
