import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseArgs } from './utils.js';

const args = parseArgs(process.argv.slice(2), { required: ['app-path', 'tag', 'pr-number', 'repo-owner'] });
const appRepoPath = args['app-repo-path'];

const appPath = args['app-path'];
const tag = args['tag'];
const prNumber = args['pr-number'];
const repoOwner = args['repo-owner'];

const appName = path.basename(appPath);
const tempName = `${appName}-pr-${prNumber}`;
const tempPath = `${appPath}-pr-${prNumber}`;

// Copy app directory
fs.rmSync(tempPath, { recursive: true, force: true });
fs.cpSync(appPath, tempPath, { recursive: true });

// Override .env.sops from app repo if present
if (appRepoPath) {
	const appRepoSops = path.join(appRepoPath, '.env.sops');
	if (fs.existsSync(appRepoSops)) {
		fs.cpSync(appRepoSops, path.join(tempPath, '.env.sops.override'));
		console.log('Copied .env.sops from app repo as .env.sops.override');
	}
}

// Parse compose
const composePath = path.join(tempPath, 'docker-compose.yml');
const doc = yaml.load(fs.readFileSync(composePath, 'utf8'));

// Auto-detect domain from traefik Host() labels
let originalHost = null;
for (const [, service] of Object.entries(doc.services)) {
	if (!service.labels) continue;
	for (const label of service.labels) {
		const match = label.match(/Host\(`([^`]+)`\)/);
		if (match) {
			originalHost = match[1];
			break;
		}
	}
	if (originalHost) break;
}

if (!originalHost) {
	console.error('Could not detect domain from traefik Host() labels');
	process.exit(1);
}

// e.g. "bang.jaw.dev" → domain is "jaw.dev"
const domain = originalHost.split('.').slice(1).join('.');
const hostname = `pr-${prNumber}-${appName}.${domain}`;

const volumeNames = new Set();

for (const [, service] of Object.entries(doc.services)) {
	// Rewrite our ghcr.io image tag
	if (service.image?.startsWith(`ghcr.io/${repoOwner}/`)) {
		const imageName = service.image.split(':')[0];
		service.image = `${imageName}:${tag}`;
	}

	// Rewrite traefik labels
	if (service.labels) {
		service.labels = service.labels.map((label) =>
			label
				.replaceAll(`traefik.http.routers.${appName}`, `traefik.http.routers.${tempName}`)
				.replaceAll(`traefik.http.services.${appName}`, `traefik.http.services.${tempName}`)
				.replaceAll(originalHost, hostname),
		);
	}

	// Convert all bind mounts to named volumes
	if (service.volumes) {
		service.volumes = service.volumes.map((vol) => {
			if (typeof vol !== 'string') return vol;

			const [hostPath, ...rest] = vol.split(':');
			const containerPath = rest.join(':');

			// Skip non-absolute paths (already named volumes)
			if (!path.isAbsolute(hostPath)) return vol;

			const volName = hostPath.split('/').filter(Boolean).pop() || 'data';

			volumeNames.add(volName);
			return `${volName}:${containerPath}`;
		});
	}
}

// Add named volume declarations
if (volumeNames.size > 0) {
	doc.volumes = doc.volumes || {};
	for (const name of volumeNames) {
		doc.volumes[name] = null;
	}
}

// Write modified compose
fs.writeFileSync(composePath, yaml.dump(doc, { lineWidth: -1, quotingType: '"', forceQuotes: false }));

// Force no rolling update
fs.writeFileSync(path.join(tempPath, 'docker-cd.yml'), 'rolling_update: false\n');

console.log(`Created temp stack at ${tempPath}`);
console.log(`URL: https://${hostname}`);
console.log('--- docker-compose.yml ---');
console.log(fs.readFileSync(composePath, 'utf8'));

// Output for GitHub Actions
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile) {
	fs.appendFileSync(outputFile, `url=https://${hostname}\n`);
	fs.appendFileSync(outputFile, `temp-path=${tempPath}\n`);
}
