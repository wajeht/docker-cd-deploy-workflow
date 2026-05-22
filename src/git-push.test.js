import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from './git-push.js';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'git-push.js');

function writeFakeGit(binDir) {
	const gitPath = path.join(binDir, 'git');
	fs.writeFileSync(
		gitPath,
		[
			'#!/usr/bin/env node',
			"import fs from 'node:fs';",
			'const args = process.argv.slice(2);',
			'fs.appendFileSync(process.env.GIT_LOG, `${JSON.stringify(args)}\\n`);',
			"if (args.join(' ') === 'diff --staged --quiet' && process.env.GIT_DIFF_HAS_CHANGES === 'true') {",
			'  process.exit(1);',
			'}',
			"if (args.join(' ') === 'push' && process.env.GIT_PUSH_FAIL_ONCE === 'true') {",
			'  const count = fs.existsSync(process.env.GIT_PUSH_COUNT) ? Number(fs.readFileSync(process.env.GIT_PUSH_COUNT, "utf8")) : 0;',
			'  fs.writeFileSync(process.env.GIT_PUSH_COUNT, String(count + 1));',
			'  if (count === 0) process.exit(1);',
			'}',
			'',
		].join('\n'),
	);
	fs.chmodSync(gitPath, 0o755);
}

function runGitPush(args, env = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-cd-deploy-workflow-'));
	const binDir = path.join(dir, 'bin');
	const logPath = path.join(dir, 'git.log');
	const pushCountPath = path.join(dir, 'push-count');

	try {
		fs.mkdirSync(binDir);
		writeFakeGit(binDir);
		execFileSync(process.execPath, [scriptPath, ...args], {
			cwd: dir,
			env: {
				...process.env,
				...env,
				PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
				GIT_LOG: logPath,
				GIT_PUSH_COUNT: pushCountPath,
			},
			stdio: 'pipe',
		});

		return fs
			.readFileSync(logPath, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe('git-push', () => {
	it('commits selected paths and pushes', () => {
		const calls = runGitPush(['--paths', 'apps/demo', '--message', 'chore: deploy demo'], {
			GIT_DIFF_HAS_CHANGES: 'true',
		});

		assert.deepStrictEqual(calls, [
			['config', 'user.name', 'github-actions[bot]'],
			['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'],
			['add', 'apps/demo'],
			['diff', '--staged', '--quiet'],
			['commit', '-m', 'chore: deploy demo'],
			['push'],
		]);
	});

	it('commits all changes when --all is set', () => {
		const calls = runGitPush(['--all', '--message', 'chore: cleanup demo'], {
			GIT_DIFF_HAS_CHANGES: 'true',
		});

		assert.deepStrictEqual(calls[2], ['add', '-A']);
	});

	it('stops when there are no staged changes', () => {
		const calls = runGitPush(['--paths', 'apps/demo', '--message', 'chore: deploy demo']);

		assert.deepStrictEqual(calls, [
			['config', 'user.name', 'github-actions[bot]'],
			['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'],
			['add', 'apps/demo'],
			['diff', '--staged', '--quiet'],
		]);
	});

	it('rebases and retries when push fails', () => {
		const calls = runGitPush(['--paths', 'apps/demo', '--message', 'chore: deploy demo'], {
			GIT_DIFF_HAS_CHANGES: 'true',
			GIT_PUSH_FAIL_ONCE: 'true',
		});

		assert.deepStrictEqual(calls.slice(-3), [
			['push'],
			['pull', '--rebase', 'origin', 'main'],
			['push'],
		]);
	});

	it('requires paths or all', async () => {
		await assert.rejects(() => main(['--message', 'chore: deploy demo']), /Missing required arg: --paths or --all/);
	});
});
