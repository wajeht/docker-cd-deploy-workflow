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
		if (env.GIT_WITH_TINYAUTH === 'true') {
			fs.mkdirSync(path.join(dir, 'apps/tinyauth'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'apps/tinyauth/docker-compose.yml'), 'services: {}');
		}
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

it('stages the preview and Tinyauth config in the same commit', () => {
	const calls = runGitPush(['--paths', 'apps/demo-pr-42', '--message', 'preview'], { GIT_DIFF_HAS_CHANGES: 'true', GIT_WITH_TINYAUTH: 'true' });
	assert.deepStrictEqual(calls.filter(([command]) => command === 'add'), [['add', 'apps/demo-pr-42'], ['add', 'apps/tinyauth/docker-compose.yml']]);
});

it('fails safely on a concurrent ACL conflict and preserves both rules after rerun', async () => {
	const { updateAccess, authPath, previewId } = await import('./temp-cleanup.js');
	const { adminAllow, authEnvironment } = await import('./temp-compose.js');
	const { deployedRevisionMatches } = await import('./deployment.js');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-conflict-'));
	const cwd = process.cwd();
	const git = (where, ...args) => execFileSync('git', args, { cwd: where, encoding: 'utf8', stdio: 'pipe' }).trim();
	const first = path.join(dir, 'first'), second = path.join(dir, 'second');
	const config = 'x-docker-cd:\n  rolling_update: false\nservices:\n  tinyauth:\n    environment:\n      TINYAUTH_AUTH_ACLS_POLICY: deny\n';
	const rule = (pr) => ({ appPath: 'apps/demo', prNumber: pr, hostname: `pr-${pr}-demo.example.com`, allowlist: adminAllow });
	const push = () => execFileSync(process.execPath, [scriptPath, '--paths', authPath, '--message', 'preview'], { cwd: first, stdio: 'pipe' });
	try {
		git(dir, 'init', '--bare', '--initial-branch=main', 'remote.git');
		git(dir, 'clone', path.join(dir, 'remote.git'), first);
		git(first, 'config', 'user.name', 'Test'); git(first, 'config', 'user.email', 'test@example.com');
		fs.mkdirSync(path.join(first, 'apps/tinyauth'), { recursive: true });
		fs.writeFileSync(path.join(first, authPath), config);
		git(first, 'add', '.'); git(first, 'commit', '-m', 'initial'); git(first, 'push', 'origin', 'main');
		git(dir, 'clone', path.join(dir, 'remote.git'), second);
		git(second, 'config', 'user.name', 'Test'); git(second, 'config', 'user.email', 'test@example.com');
		const other = updateAccess(config, rule('43'));
		fs.writeFileSync(path.join(second, authPath), other);
		git(second, 'add', '.'); git(second, 'commit', '-m', 'preview 43'); git(second, 'push', 'origin', 'main');
		fs.writeFileSync(path.join(first, authPath), updateAccess(config, rule('42')));
		assert.throws(push, /Concurrent changes conflict/);
		assert.strictEqual(git(first, 'show', `origin/main:${authPath}`), other.trim());
		git(first, 'rebase', '--abort'); git(first, 'reset', '--hard', 'origin/main');
		const previous = git(first, 'rev-parse', 'HEAD');
		fs.writeFileSync(path.join(first, authPath), updateAccess(other, rule('42')));
		push();
		const current = git(first, 'rev-parse', 'HEAD');
		const env = authEnvironment(git(first, 'show', `HEAD:${authPath}`));
		for (const pr of ['42', '43']) assert.strictEqual(env[`TINYAUTH_APPS_${previewId('apps/demo', pr)}_OAUTH_WHITELIST`], adminAllow);
		process.chdir(first);
		assert.strictEqual(deployedRevisionMatches(previous, current, 'apps/demo-pr-43', true), true);
		assert.strictEqual(deployedRevisionMatches(previous, current, 'apps/demo-pr-42', true), false);
		assert.strictEqual(deployedRevisionMatches(current, previous, 'apps/demo-pr-42', true), false);
	} finally {
		process.chdir(cwd);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
