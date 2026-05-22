import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './utils.js';

export async function main(argv = process.argv.slice(2), exec = execFileSync) {
	const args = parseArgs(argv, { required: ['message'] });
	function run(cmd, cmdArgs) {
		console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
		return exec(cmd, cmdArgs, { stdio: 'inherit' });
	}

	if (!args['paths'] && !args['all']) {
		throw new Error('Missing required arg: --paths or --all');
	}

	const message = args['message'];
	const paths = args['paths'];
	const all = args['all'] === true;

	run('git', ['config', 'user.name', 'github-actions[bot]']);
	run('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);

	if (all) {
		run('git', ['add', '-A']);
	} else {
		try {
			run('git', ['add', paths]);
		} catch {
			// path may not exist (already cleaned up), check for staged changes below
		}
	}

	try {
		exec('git', ['diff', '--staged', '--quiet']);
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
			run('git', ['pull', '--rebase', 'origin', 'main']);
		}
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}
