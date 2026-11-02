import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from './git.js';
import {
	updateAccess,
	AUTH_PATH,
	previewId,
	ADMIN_ALLOW,
	parseAuthEnvironment,
} from './preview.js';
import { isDeploymentCurrent } from './deployment.js';

const REGEX_REQUIRED_PATHS = /Missing required arg: --paths or --all/;
const REGEX_PUSH_CONFLICT = /Concurrent changes conflict/;

const SCRIPT_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'git.js',
);

function writeFakeGit(binDir) {
	const gitPath = path.join(binDir, 'git');
	fs.writeFileSync(
		gitPath,
		[
			'#!/usr/bin/env node',
			"import fs from 'node:fs';",
			'const args = process.argv.slice(2);',
			'fs.appendFileSync(process.env.GIT_LOG, `${JSON.stringify(args)}\\n`);',
			"if (args.join(' ') === 'diff --staged --quiet' && process.env.GIT_DIFF_ERROR === 'true') process.exit(2);",
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
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'docker-cd-deploy-workflow-'),
	);
	const binDir = path.join(dir, 'bin');
	const logPath = path.join(dir, 'git.log');
	const pushCountPath = path.join(dir, 'push-count');

	try {
		fs.mkdirSync(binDir);
		writeFakeGit(binDir);

		execFileSync(process.execPath, [SCRIPT_PATH, ...args], {
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

		const calls = [];
		for (const line of fs.readFileSync(logPath, 'utf8').trim().split('\n')) {
			if (line) {
				calls.push(JSON.parse(line));
			}
		}
		return calls;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe('git', function () {
	it('commits selected paths and pushes', function () {
		const calls = runGitPush(
			['--paths', 'apps/demo', '--message', 'chore: deploy demo'],
			{
				GIT_DIFF_HAS_CHANGES: 'true',
			},
		);

		assert.deepStrictEqual(calls, [
			['config', 'user.name', 'github-actions[bot]'],
			['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'],
			['add', 'apps/demo'],
			['diff', '--staged', '--quiet'],
			['commit', '-m', 'chore: deploy demo'],
			['push'],
		]);
	});

	it('commits all changes when --all is set', function () {
		const calls = runGitPush(['--all', '--message', 'chore: cleanup demo'], {
			GIT_DIFF_HAS_CHANGES: 'true',
		});

		assert.deepStrictEqual(calls[2], ['add', '-A']);
	});

	it('stops when there are no staged changes', function () {
		const calls = runGitPush([
			'--paths',
			'apps/demo',
			'--message',
			'chore: deploy demo',
		]);

		assert.deepStrictEqual(calls, [
			['config', 'user.name', 'github-actions[bot]'],
			['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'],
			['add', 'apps/demo'],
			['diff', '--staged', '--quiet'],
		]);
	});

	it('rebases and retries when push fails', function () {
		const calls = runGitPush(
			['--paths', 'apps/demo', '--message', 'chore: deploy demo'],
			{
				GIT_DIFF_HAS_CHANGES: 'true',
				GIT_PUSH_FAIL_ONCE: 'true',
			},
		);

		assert.deepStrictEqual(calls.slice(-3), [
			['push'],
			['pull', '--rebase', 'origin', 'main'],
			['push'],
		]);
	});

	it('does not commit when the staged diff command fails', () => {
		assert.throws(() =>
			runGitPush(['--paths', 'apps/demo', '--message', 'preview'], {
				GIT_DIFF_ERROR: 'true',
			}),
		);
	});

	it('requires paths or all', async () => {
		await assert.rejects(
			() => main(['--message', 'chore: deploy demo']),
			REGEX_REQUIRED_PATHS,
		);
	});

	it('stages the preview and Tinyauth config in the same commit', function () {
		const calls = runGitPush(
			[
				'--paths',
				'apps/demo-pr-42',
				'--paths',
				'apps/tinyauth/docker-compose.yml',
				'--message',
				'preview',
			],
			{ GIT_DIFF_HAS_CHANGES: 'true' },
		);
		assert.deepStrictEqual(
			calls.filter(([command]) => command === 'add'),
			[
				['add', 'apps/demo-pr-42'],
				['add', 'apps/tinyauth/docker-compose.yml'],
			],
		);
	});

	it('fails safely on a concurrent ACL conflict and preserves both rules after rerun', async function () {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-conflict-'));
		const cwd = process.cwd();
		function runGit(directory, ...args) {
			return execFileSync('git', args, {
				cwd: directory,
				encoding: 'utf8',
				stdio: 'pipe',
			}).trim();
		}
		const first = path.join(dir, 'first');
		const second = path.join(dir, 'second');
		const config =
			'x-docker-cd:\n  rolling_update: false\nservices:\n  tinyauth:\n    environment:\n      TINYAUTH_AUTH_ACLS_POLICY: deny\n';
		function rule(pr) {
			return {
				appPath: 'apps/demo',
				prNumber: pr,
				hostname: `pr-${pr}-demo.example.com`,
				allowlist: ADMIN_ALLOW,
			};
		}
		function pushPreview() {
			return execFileSync(
				process.execPath,
				[SCRIPT_PATH, '--paths', AUTH_PATH, '--message', 'preview'],
				{ cwd: first, stdio: 'pipe' },
			);
		}
		try {
			runGit(dir, 'init', '--bare', '--initial-branch=main', 'remote.git');
			runGit(dir, 'clone', path.join(dir, 'remote.git'), first);
			runGit(first, 'config', 'user.name', 'Test');
			runGit(first, 'config', 'user.email', 'test@example.com');
			fs.mkdirSync(path.join(first, 'apps/tinyauth'), { recursive: true });
			fs.writeFileSync(path.join(first, AUTH_PATH), config);
			runGit(first, 'add', '.');
			runGit(first, 'commit', '-m', 'initial');
			runGit(first, 'push', 'origin', 'main');
			runGit(dir, 'clone', path.join(dir, 'remote.git'), second);
			runGit(second, 'config', 'user.name', 'Test');
			runGit(second, 'config', 'user.email', 'test@example.com');
			const other = updateAccess(config, rule('43'));
			fs.writeFileSync(path.join(second, AUTH_PATH), other);
			runGit(second, 'add', '.');
			runGit(second, 'commit', '-m', 'preview 43');
			runGit(second, 'push', 'origin', 'main');
			fs.writeFileSync(
				path.join(first, AUTH_PATH),
				updateAccess(config, rule('42')),
			);
			assert.throws(pushPreview, REGEX_PUSH_CONFLICT);
			assert.strictEqual(
				runGit(first, 'show', `origin/main:${AUTH_PATH}`),
				other.trim(),
			);
			runGit(first, 'rebase', '--abort');
			runGit(first, 'reset', '--hard', 'origin/main');
			const previous = runGit(first, 'rev-parse', 'HEAD');
			fs.writeFileSync(
				path.join(first, AUTH_PATH),
				updateAccess(other, rule('42')),
			);
			pushPreview();
			const current = runGit(first, 'rev-parse', 'HEAD');
			const env = parseAuthEnvironment(
				runGit(first, 'show', `HEAD:${AUTH_PATH}`),
			);
			for (const pr of ['42', '43']) {
				assert.strictEqual(
					env[`TINYAUTH_APPS_${previewId('apps/demo', pr)}_OAUTH_WHITELIST`],
					ADMIN_ALLOW,
				);
			}
			process.chdir(first);
			assert.strictEqual(
				isDeploymentCurrent(previous, current, 'apps/demo-pr-43', true),
				true,
			);
			assert.strictEqual(
				isDeploymentCurrent(previous, current, 'apps/demo-pr-42', true),
				false,
			);
			assert.strictEqual(
				isDeploymentCurrent(current, previous, 'apps/demo-pr-42', true),
				false,
			);
			fs.appendFileSync(AUTH_PATH, '# changed global auth configuration\n');
			runGit(first, 'add', AUTH_PATH);
			runGit(first, 'commit', '-m', 'change auth configuration');
			assert.strictEqual(
				isDeploymentCurrent(
					current,
					runGit(first, 'rev-parse', 'HEAD'),
					'apps/demo-pr-42',
					true,
				),
				false,
			);
		} finally {
			process.chdir(cwd);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
