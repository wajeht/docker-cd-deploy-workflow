import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { main } from './git.js';
import { AUTH_PATH, previewId, parseAuthEnvironment } from './preview.js';
import { isDeploymentCurrent } from './deployment.js';

const REGEX_REQUIRED_PATHS = /Missing required arg: --paths or --all/;
const REGEX_RETRY = /Preparing changes again/;

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
			"if (args[0] === 'add' && args.includes('--dry-run')) console.log('changes');",
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
			['add', '--dry-run', '--ignore-missing', '--', 'apps/demo'],
			['add', '--', 'apps/demo'],
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
			['add', '--dry-run', '--ignore-missing', '--', 'apps/demo'],
			['add', '--', 'apps/demo'],
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

	it('does not commit when the staged diff command fails', function () {
		assert.throws(() =>
			runGitPush(['--paths', 'apps/demo', '--message', 'preview'], {
				GIT_DIFF_ERROR: 'true',
			}),
		);
	});

	it('requires paths or all', async function () {
		await assert.rejects(
			() => main(['--message', 'chore: deploy demo']),
			REGEX_REQUIRED_PATHS,
		);
	});

	it('retries preview creation and cleanup against concurrent auth changes', function () {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-conflict-'));
		const checkout = path.join(dir, 'checkout');
		const competitor = path.join(dir, 'competitor');
		const remote = path.join(dir, 'remote.git');
		const outputFile = path.join(dir, 'output');
		const raceFile = path.join(dir, 'race');
		const root = path.resolve(path.dirname(SCRIPT_PATH), '..');

		function runGit(directory, ...args) {
			return execFileSync('git', args, {
				cwd: directory,
				encoding: 'utf8',
				stdio: 'pipe',
			}).trim();
		}
		function publish(workflowName, appPath, concurrentPr) {
			const workflow = load(
				fs.readFileSync(
					path.join(root, '.github/workflows', workflowName),
					'utf8',
				),
			);
			const job = Object.values(workflow.jobs)[0];
			const step = job.steps.find((step) =>
				step.run?.includes('src/preview.js'),
			);
			const command = step.run
				.replaceAll('${{ inputs.app-path }}', appPath)
				.replaceAll('${{ inputs.service-name }}', 'demo')
				.replaceAll('${{ inputs.tag }}', 'preview')
				.replaceAll('${{ inputs.auth-middleware }}', 'tinyauth@file')
				.replaceAll('${{ github.event.pull_request.number }}', '42')
				.replaceAll('${{ github.repository_owner }}', 'test')
				.replaceAll('${{ github.event.repository.name }}', 'demo');
			fs.writeFileSync(outputFile, '');
			if (concurrentPr) {
				fs.writeFileSync(raceFile, concurrentPr);
			}
			const log = execFileSync('bash', ['-e', '-c', command], {
				cwd: checkout,
				env: {
					...process.env,
					GITHUB_OUTPUT: outputFile,
					RACE_FILE: raceFile,
					COMPETITOR: competitor,
					NODE_BINARY: process.execPath,
					PREVIEW_SCRIPT: path.join(root, 'src/preview.js'),
				},
				encoding: 'utf8',
				stdio: 'pipe',
			});
			if (concurrentPr) {
				assert.match(log, REGEX_RETRY);
			}
			return fs.readFileSync(outputFile, 'utf8');
		}
		function ruleGroup(pr) {
			const config = runGit(remote, 'show', `HEAD:${AUTH_PATH}`);
			return parseAuthEnvironment(config)[
				`TINYAUTH_APPS_${previewId('apps/demo', pr)}_OAUTH_GROUPS`
			];
		}

		try {
			runGit(dir, 'init', '--bare', '--initial-branch=main', remote);
			runGit(dir, 'clone', remote, checkout);
			fs.mkdirSync(path.join(checkout, 'apps/demo'), { recursive: true });
			fs.mkdirSync(path.join(checkout, 'apps/tinyauth'));
			fs.writeFileSync(
				path.join(checkout, 'apps/demo/docker-compose.yml'),
				'services:\n  demo:\n    image: ghcr.io/test/demo:old\n    labels:\n      - traefik.http.routers.demo.rule=Host(`demo.example.com`)\n',
			);
			fs.writeFileSync(
				path.join(checkout, AUTH_PATH),
				'x-docker-cd:\n  rolling_update: false\nservices:\n  tinyauth:\n    environment:\n      TINYAUTH_AUTH_ACLS_POLICY: deny\n',
			);
			runGit(checkout, 'add', 'apps');
			runGit(
				checkout,
				'-c',
				'user.name=Test',
				'-c',
				'user.email=test@example.com',
				'commit',
				'-m',
				'initial',
			);
			runGit(checkout, 'push', 'origin', 'main');
			runGit(dir, 'clone', remote, competitor);
			const scripts = path.join(checkout, '.deploy-workflow');
			fs.mkdirSync(scripts);
			fs.cpSync(path.join(root, 'src'), path.join(scripts, 'src'), {
				recursive: true,
			});
			fs.copyFileSync(
				path.join(root, 'package.json'),
				path.join(scripts, 'package.json'),
			);
			fs.symlinkSync(
				path.join(root, 'node_modules'),
				path.join(scripts, 'node_modules'),
				'dir',
			);
			fs.writeFileSync(
				path.join(checkout, '.git/hooks/pre-push'),
				`#!/bin/sh
if [ -f "$RACE_FILE" ]; then
  pr=$(cat "$RACE_FILE")
  rm "$RACE_FILE"
  cd "$COMPETITOR" || exit 1
  unset GITHUB_OUTPUT
  exec "$NODE_BINARY" "$PREVIEW_SCRIPT" --action create --app-path apps/demo \\
    --pr-number "$pr" --service-name demo --tag preview --repo-owner test \\
    --auth-middleware tinyauth@file --message "concurrent preview"
fi
`,
				{ mode: 0o755 },
			);

			const previewPath = path.join(
				fs.realpathSync(checkout),
				'apps/demo-pr-42',
			);
			assert.strictEqual(
				publish('temp-deploy.yaml', 'apps/demo/', '43'),
				`url=https://pr-42-demo.example.com\ntemp-path=${previewPath}\n`,
			);
			assert.strictEqual(ruleGroup('42'), 'admins');
			assert.strictEqual(ruleGroup('43'), 'admins');
			assert.strictEqual(
				runGit(remote, 'ls-tree', '--name-only', 'HEAD', 'apps/demo-pr-42'),
				'apps/demo-pr-42',
			);
			const created = runGit(remote, 'rev-parse', 'HEAD');

			assert.strictEqual(
				publish('temp-cleanup.yaml', 'apps/demo/.', '44'),
				`temp-path=${previewPath}\n`,
			);
			assert.strictEqual(ruleGroup('42'), undefined);
			assert.strictEqual(ruleGroup('43'), 'admins');
			assert.strictEqual(ruleGroup('44'), 'admins');
			assert.strictEqual(
				runGit(remote, 'ls-tree', '--name-only', 'HEAD', 'apps/demo-pr-42'),
				'',
			);

			const cleaned = runGit(remote, 'rev-parse', 'HEAD');
			publish('temp-cleanup.yaml', 'apps/demo');
			assert.strictEqual(runGit(remote, 'rev-parse', 'HEAD'), cleaned);

			const cwd = process.cwd();
			try {
				process.chdir(checkout);
				assert.strictEqual(
					isDeploymentCurrent(created, cleaned, 'apps/demo-pr-43', true),
					true,
				);
				assert.strictEqual(
					isDeploymentCurrent(created, cleaned, 'apps/demo-pr-42', true),
					false,
				);
				assert.strictEqual(
					isDeploymentCurrent(cleaned, created, 'apps/demo-pr-43', true),
					false,
				);
			} finally {
				process.chdir(cwd);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
