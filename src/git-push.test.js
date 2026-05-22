import { describe, it } from 'node:test';
import assert from 'node:assert';
import { main } from './git-push.js';

function fakeExec(failures = {}) {
	const calls = [];
	function exec(cmd, args) {
		const key = [cmd, ...args].join(' ');
		calls.push([cmd, args]);
		const failure = failures[key];
		if (failure) {
			failure.count = (failure.count || 0) + 1;
			if (!failure.after || failure.count <= failure.after) {
				throw new Error(key);
			}
		}
	}
	exec.calls = calls;
	return exec;
}

describe('git-push', () => {
	it('commits selected paths and pushes', async () => {
		const exec = fakeExec({ 'git diff --staged --quiet': {} });

		await main(['--paths', 'apps/demo', '--message', 'chore: deploy demo'], exec);

		assert.deepStrictEqual(exec.calls, [
			['git', ['config', 'user.name', 'github-actions[bot]']],
			['git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']],
			['git', ['add', 'apps/demo']],
			['git', ['diff', '--staged', '--quiet']],
			['git', ['commit', '-m', 'chore: deploy demo']],
			['git', ['push']],
		]);
	});

	it('commits all changes when --all is set', async () => {
		const exec = fakeExec({ 'git diff --staged --quiet': {} });

		await main(['--all', '--message', 'chore: cleanup demo'], exec);

		assert.deepStrictEqual(exec.calls[2], ['git', ['add', '-A']]);
	});

	it('stops when there are no staged changes', async () => {
		const exec = fakeExec();

		await main(['--paths', 'apps/demo', '--message', 'chore: deploy demo'], exec);

		assert.deepStrictEqual(exec.calls, [
			['git', ['config', 'user.name', 'github-actions[bot]']],
			['git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']],
			['git', ['add', 'apps/demo']],
			['git', ['diff', '--staged', '--quiet']],
		]);
	});

	it('rebases and retries when push fails', async () => {
		const exec = fakeExec({
			'git diff --staged --quiet': {},
			'git push': { after: 1 },
		});

		await main(['--paths', 'apps/demo', '--message', 'chore: deploy demo'], exec);

		assert.deepStrictEqual(exec.calls.slice(-3), [
			['git', ['push']],
			['git', ['pull', '--rebase', 'origin', 'main']],
			['git', ['push']],
		]);
	});

	it('requires paths or all', async () => {
		await assert.rejects(() => main(['--message', 'chore: deploy demo'], fakeExec()), /Missing required arg: --paths or --all/);
	});
});
