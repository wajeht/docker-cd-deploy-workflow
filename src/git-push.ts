import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

type GitPushArgs = {
	message?: string;
	paths?: string;
	all?: boolean;
};

function requireArg(args: GitPushArgs, key: keyof GitPushArgs): string {
	const value = args[key];
	if (typeof value !== 'string' || !value) throw new Error(`Missing required arg: --${key}`);
	return value;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			message: { type: 'string' },
			paths: { type: 'string' },
			all: { type: 'boolean' },
		},
	});
	const args = values as GitPushArgs;
	const message = requireArg(args, 'message');
	function run(cmd: string, cmdArgs: string[]): Buffer {
		console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
		return execFileSync(cmd, cmdArgs, { stdio: 'inherit' });
	}

	const paths = args.paths;
	const all = args.all === true;
	if (!paths && !all) {
		throw new Error('Missing required arg: --paths or --all');
	}

	run('git', ['config', 'user.name', 'github-actions[bot]']);
	run('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);

	if (all) {
		run('git', ['add', '-A']);
	} else if (paths) {
		try {
			run('git', ['add', paths]);
		} catch {
			// path may not exist (already cleaned up), check for staged changes below
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
