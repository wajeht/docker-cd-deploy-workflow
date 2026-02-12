const fs = require('fs');
const path = require('path');

const args = parseArgs(process.argv.slice(2));

const required = ['app-path', 'tag', 'repo'];
for (const key of required) {
	if (!args[key]) {
		console.error(`Missing required arg: --${key}`);
		process.exit(1);
	}
}

const appPath = args['app-path'];
const tag = args['tag'];
const repo = args['repo'];

const composePath = path.join(appPath, 'docker-compose.yml');
let content = fs.readFileSync(composePath, 'utf8');

const pattern = new RegExp(`(image:\\s*ghcr\\.io/${repo}):.*`, 'g');
const updated = content.replace(pattern, `$1:${tag}`);

if (updated === content) {
	console.log(`No changes - image ghcr.io/${repo} not found or already at ${tag}`);
	process.exit(0);
}

fs.writeFileSync(composePath, updated);
console.log(`Updated ghcr.io/${repo} to tag ${tag} in ${composePath}`);

function parseArgs(argv) {
	const result = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) {
			const key = argv[i].slice(2);
			const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
			result[key] = val;
		}
	}
	return result;
}
