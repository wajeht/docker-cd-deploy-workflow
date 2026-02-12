import { execFileSync } from 'node:child_process';

import { parseArgs } from './utils.js';

const args = parseArgs(process.argv.slice(2));

if (!args['message']) {
	console.error('Missing required arg: --message');
	process.exit(1);
}
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
	run('git', ['add', paths]);
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
	} catch {
		console.log(`Push failed (attempt ${i}), rebasing...`);
		run('git', ['pull', '--rebase', 'origin', 'main']);
	}
}
