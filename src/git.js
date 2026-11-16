import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

function runGit(args) {
	console.log(`$ git ${args.join(' ')}`);
	execFileSync('git', args, { stdio: 'inherit' });
}

function readGit(args) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function fetchMain() {
	runGit(['fetch', 'origin', 'main']);
	return readGit(['rev-parse', 'FETCH_HEAD']);
}

function commitChanges(paths, allFiles, message) {
	if (allFiles) {
		runGit(['add', '-A']);
	} else {
		for (const selectedPath of paths) {
			// Skip a path already removed by cleanup while still staging tracked deletions.
			const changes = readGit([
				'add',
				'--dry-run',
				'--ignore-missing',
				'--',
				selectedPath,
			]);
			if (changes) {
				runGit(['add', '--', selectedPath]);
			}
		}
	}

	try {
		execFileSync('git', ['diff', '--staged', '--quiet']);
		console.log('No changes to commit');
		return false;
	} catch (error) {
		if (!(error instanceof Error) || error.status !== 1) {
			throw error;
		}
	}

	runGit(['commit', '-m', message]);
	return true;
}

export function commitAndPush({ paths, allFiles = false, message, prepare }) {
	let base;
	if (prepare) {
		if (readGit(['status', '--porcelain', '--untracked-files=no'])) {
			throw new Error('Preparing changes requires a clean checkout');
		}
		base = fetchMain();
		runGit(['merge', '--ff-only', base]);
		if (readGit(['rev-parse', 'HEAD']) !== base) {
			throw new Error('Checkout has local commits ahead of origin/main');
		}
	}

	runGit(['config', 'user.name', 'github-actions[bot]']);
	runGit([
		'config',
		'user.email',
		'github-actions[bot]@users.noreply.github.com',
	]);
	const pushArgs = prepare
		? ['push', 'origin', 'HEAD:refs/heads/main']
		: ['push'];
	let result;

	for (let attempt = 1; attempt <= 3; attempt++) {
		if (prepare) {
			result = prepare();
		}
		if (
			(prepare || attempt === 1) &&
			!commitChanges(paths, allFiles, message)
		) {
			return result;
		}
		try {
			runGit(pushArgs);
			return result;
		} catch (error) {
			if (attempt === 3) {
				throw new Error('Push failed after 3 attempts', { cause: error });
			}
			if (prepare) {
				const latest = fetchMain();
				if (latest === base) {
					throw new Error('Push failed without a change to origin/main', {
						cause: error,
					});
				}
				// Reapply the operation to preserve concurrent edits to shared files.
				console.log('Main changed during push. Preparing changes again.');
				runGit(['reset', '--keep', latest]);
				base = latest;
				continue;
			}
			console.log(`Push failed (attempt ${attempt}/3), rebasing...`);
			try {
				runGit(['pull', '--rebase', 'origin', 'main']);
			} catch {
				throw new Error(
					'Concurrent changes conflict; rerun the workflow from the latest Home Ops main',
				);
			}
		}
	}
}

export async function main(argv = process.argv.slice(2)) {
	const { values: args } = parseArgs({
		args: argv,
		options: {
			message: { type: 'string' },
			paths: { type: 'string', multiple: true },
			all: { type: 'boolean' },
		},
	});
	if (!args.message) {
		throw new Error('Missing required arg: --message');
	}
	if (!args.paths && !args.all) {
		throw new Error('Missing required arg: --paths or --all');
	}
	commitAndPush({
		paths: args.paths,
		allFiles: args.all,
		message: args.message,
	});
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	main().catch(function (err) {
		console.error(err.message);
		process.exit(1);
	});
}
