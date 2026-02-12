import fs from 'node:fs';
import path from 'node:path';

import { parseArgs } from './utils.js';

const args = parseArgs(process.argv.slice(2));

const required = ['app-path', 'tag', 'repo'];
for (const key of required) {
	if (!args[key]) {
		console.error(`Missing required arg: --${key}`);
		process.exit(1);
	}
}

const { 'app-path': appPath, tag, repo } = args;

const composePath = path.join(appPath, 'docker-compose.yml');
const content = fs.readFileSync(composePath, 'utf8');

const pattern = new RegExp(`(image:\\s*ghcr\\.io/${repo}):.*`, 'g');
const updated = content.replace(pattern, `$1:${tag}`);

if (updated === content) {
	console.log(`No changes - image ghcr.io/${repo} not found or already at ${tag}`);
	process.exit(0);
}

fs.writeFileSync(composePath, updated);
console.log(`Updated ghcr.io/${repo} to tag ${tag} in ${composePath}`);
