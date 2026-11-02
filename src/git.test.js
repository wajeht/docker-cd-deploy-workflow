import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { main } from './git.js';
import {
	updateAccess,
	AUTH_PATH,
	previewId,
	ADMIN_ALLOW,
	parseAuthEnvironment,
} from './preview.js';
import { isDeploymentCurrent } from './deployment.js';

const REGEX_STAGE_PATH = /--paths "([^"]+)"/;

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
	it('commits preview creation and cleanup using workflow output paths', function () {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-workflow-'));
		const checkout = path.join(dir, 'checkout');
		const remote = path.join(dir, 'remote.git');
		const outputFile = path.join(dir, 'output');
		const source = path.dirname(SCRIPT_PATH);
		const workflowDir = path.resolve(source, '..', '.github/workflows');
		const deploy = yaml.load(
			fs.readFileSync(path.join(workflowDir, 'temp-deploy.yaml'), 'utf8'),
		);
		const cleanup = yaml.load(
			fs.readFileSync(path.join(workflowDir, 'temp-cleanup.yaml'), 'utf8'),
		);

		function runGit(directory, ...args) {
			return execFileSync('git', args, {
				cwd: directory,
				encoding: 'utf8',
				stdio: 'pipe',
			}).trim();
		}
		function runPreview(action, appPath) {
			fs.writeFileSync(outputFile, '');
			const args = [
				'--action',
				action,
				'--app-path',
				appPath,
				'--pr-number',
				'42',
			];
			if (action === 'create') {
				args.push(
					'--service-name',
					'demo',
					'--tag',
					'new',
					'--repo-owner',
					'test',
				);
			}
			execFileSync(
				process.execPath,
				[path.join(source, 'preview.js'), ...args],
				{
					cwd: checkout,
					env: { ...process.env, GITHUB_OUTPUT: outputFile },
					stdio: 'pipe',
				},
			);
			for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
				if (line.startsWith('temp-path=')) {
					return line.slice('temp-path='.length);
				}
			}
			assert.fail('Preview action did not emit its canonical path');
		}
		function commitWorkflow(workflow, appPath, previewPath) {
			const job = Object.values(workflow.jobs)[0];
			const previewStep = job.steps.find((step) =>
				step.run?.includes('src/preview.js'),
			);
			const commitStep = job.steps.find(
				(step) => step.name === 'Commit and push',
			);
			const command = commitStep.run
				.replaceAll('${{ inputs.app-path }}', appPath)
				.replaceAll('${{ github.event.pull_request.number }}', '42')
				.replaceAll(
					`\${{ steps.${previewStep.id}.outputs.temp-path }}`,
					previewPath,
				);
			const match = command.match(REGEX_STAGE_PATH);
			assert.ok(match, 'Workflow must explicitly select the preview path');
			execFileSync(
				process.execPath,
				[
					SCRIPT_PATH,
					'--paths',
					match[1],
					'--paths',
					AUTH_PATH,
					'--message',
					'preview lifecycle',
				],
				{
					cwd: checkout,
					stdio: 'pipe',
				},
			);
		}

		try {
			runGit(dir, 'init', '--bare', '--initial-branch=main', remote);
			runGit(dir, 'clone', remote, checkout);
			runGit(checkout, 'config', 'core.fsmonitor', 'false');
			runGit(checkout, 'config', 'user.name', 'Test');
			runGit(checkout, 'config', 'user.email', 'test@example.com');
			fs.mkdirSync(path.join(checkout, 'apps/demo'), { recursive: true });
			fs.writeFileSync(
				path.join(checkout, 'apps/demo/docker-compose.yml'),
				'services:\n  demo:\n    image: ghcr.io/test/demo:old\n    labels:\n      - traefik.http.routers.demo.rule=Host(`demo.example.com`)\n',
			);
			runGit(checkout, 'add', 'apps');
			runGit(checkout, 'commit', '-m', 'initial');
			runGit(checkout, 'push', '-u', 'origin', 'main');

			for (const appPath of ['apps/demo/', 'apps/demo/.']) {
				const previewPath = runPreview('create', appPath);
				commitWorkflow(deploy, appPath, previewPath);
				assert.strictEqual(
					runGit(
						remote,
						'ls-tree',
						'-r',
						'--name-only',
						'HEAD',
						'--',
						'apps/demo-pr-42',
					),
					'apps/demo-pr-42/docker-compose.yml',
				);
				assert.strictEqual(runPreview('cleanup', appPath), previewPath);
				commitWorkflow(cleanup, appPath, previewPath);
				assert.strictEqual(
					runGit(
						remote,
						'ls-tree',
						'-r',
						'--name-only',
						'HEAD',
						'--',
						'apps/demo-pr-42',
					),
					'',
				);
				assert.strictEqual(runPreview('cleanup', appPath), previewPath);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
