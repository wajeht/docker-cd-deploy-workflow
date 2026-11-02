import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export async function main(argv = process.argv.slice(2)) {
	const { values: args } = parseArgs({
		args: argv,
		options: {
			message: { type: 'string' },
			paths: { type: 'string', multiple: true },
			all: { type: 'boolean' },
		},
	});
	if (!args['message']) {
		throw new Error('Missing required arg: --message');
	}
	function run(cmd, cmdArgs) {
		console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
		return execFileSync(cmd, cmdArgs, { stdio: 'inherit' });
	}

	if (!args['paths'] && !args['all']) {
		throw new Error('Missing required arg: --paths or --all');
	}

	const message = args['message'];
	const paths = args['paths'];
	const all = args['all'] === true;

	run('git', ['config', 'user.name', 'github-actions[bot]']);
	run('git', [
		'config',
		'user.email',
		'github-actions[bot]@users.noreply.github.com',
	]);

	if (all) {
		run('git', ['add', '-A']);
	} else {
		for (const selectedPath of paths) {
			try {
				execFileSync('git', ['add', selectedPath], {
					stdio: ['ignore', 'pipe', 'pipe'],
				});
			} catch (error) {
				// A missing path is normal after cleanup; do not hide other staging failures.
				if (!/did not match any files/.test(String(error.stderr))) {
					throw error;
				}
			}
		}
	}

	try {
		execFileSync('git', ['diff', '--staged', '--quiet']);
		console.log('No changes to commit');
		return;
	} catch {
		// has staged changes, continue
	}

	run('git', ['commit', '-m', message]);

	for (let i = 1; i <= 3; i++) {
		try {
			run('git', ['push']);
			return;
		} catch {
			if (i === 3) {
				throw new Error('Push failed after 3 attempts');
			}
			console.log(`Push failed (attempt ${i}/3), rebasing...`);
			try {
				run('git', ['pull', '--rebase', 'origin', 'main']);
			} catch {
				throw new Error(
					'Concurrent changes conflict; rerun the workflow from the latest Home Ops main',
				);
			}
		}
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}
