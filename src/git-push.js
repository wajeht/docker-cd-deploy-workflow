import { execFileSync } from 'node:child_process';
import { parseArgs } from './utils.js';

const args = parseArgs(process.argv.slice(2), { required: ['message'] });

if (!args['paths'] && !args['all']) {
	console.error('Missing required arg: --paths or --all');
	process.exit(1);
}

const message = args['message'];
const paths = args['paths'];
const all = args['all'] === true;

const run = (cmd, cmdArgs) => {
	console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
	return execFileSync(cmd, cmdArgs, { stdio: 'inherit' });
};

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
	execFileSync('git', ['diff', '--staged', '--quiet']);
	console.log('No changes to commit');
	process.exit(0);
} catch {
	// has staged changes, continue
}

run('git', ['commit', '-m', message]);

for (let i = 1; i <= 3; i++) {
	try {
		run('git', ['push']);
		break;
	} catch (err) {
		if (i === 3) {
			console.error('Push failed after 3 attempts');
			process.exit(1);
		}
		console.log(`Push failed (attempt ${i}/3), rebasing...`);
		run('git', ['pull', '--rebase', 'origin', 'main']);
	}
}
