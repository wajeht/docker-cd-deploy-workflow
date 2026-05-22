import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseArgs, detectHost, dependentServices } from './utils.js';

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

const selectedServices = dependentServices(doc.services, appName);
if (selectedServices.size === 0) {
	console.error(`Could not find app service "${appName}" in ${composePath}`);
	process.exit(1);
}

for (const serviceName of Object.keys(doc.services)) {
	if (!selectedServices.has(serviceName)) {
		delete doc.services[serviceName];
		console.log(`Removed unrelated service: ${serviceName}`);
	}
}

// Auto-detect domain from traefik Host() labels
const originalHost = detectHost(doc.services);

if (!originalHost) {
	console.error('Could not detect domain from traefik Host() labels');
	process.exit(1);
}

// e.g. "bang.jaw.dev" → domain is "jaw.dev"
const domain = originalHost.split('.').slice(1).join('.');
const hostname = `pr-${prNumber}-${appName}.${domain}`;

function serviceNetworkNames(service) {
	if (Array.isArray(service.networks)) {
		return service.networks.filter((name) => typeof name === 'string');
	}
	if (service.networks && typeof service.networks === 'object') {
		return Object.keys(service.networks);
	}
	return [];
}

function pruneNetworks() {
	if (!doc.networks) return;

	const usedNetworks = new Set();
	for (const service of Object.values(doc.services)) {
		for (const networkName of serviceNetworkNames(service)) {
			usedNetworks.add(networkName);
		}
	}

	for (const networkName of Object.keys(doc.networks)) {
		if (!usedNetworks.has(networkName)) {
			delete doc.networks[networkName];
			console.log(`Removed unused network: ${networkName}`);
		}
	}

	if (Object.keys(doc.networks).length === 0) {
		delete doc.networks;
	}
}

function namedVolumeFromString(volume) {
	const [source] = volume.split(':');
	if (!source || path.isAbsolute(source) || source.startsWith('.')) {
		return null;
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source)) {
		return null;
	}
	return source;
}

function pruneVolumes(volumeNames) {
	if (!doc.volumes) return;

	for (const volumeName of Object.keys(doc.volumes)) {
		if (!volumeNames.has(volumeName)) {
			delete doc.volumes[volumeName];
			console.log(`Removed unused volume: ${volumeName}`);
		}
	}

	if (Object.keys(doc.volumes).length === 0) {
		delete doc.volumes;
	}
}

// Remove borgmatic services and container_name (not needed in temp deploys)
for (const [name, service] of Object.entries(doc.services)) {
	if (name.endsWith('-borgmatic')) {
		delete doc.services[name];
		console.log(`Removed borgmatic service: ${name}`);
	} else if (service.container_name) {
		delete service.container_name;
	}
}

const volumeNames = new Set();

for (const [, service] of Object.entries(doc.services)) {
	// Rewrite our ghcr.io image tag
	if (service.image?.startsWith(`ghcr.io/${repoOwner}/`)) {
		const imageName = service.image.split(':')[0];
		service.image = `${imageName}:${tag}`;
	}

	// Rewrite traefik labels
	if (service.labels) {
		service.labels = service.labels
			// Remove redirect routers/middlewares (not needed in temp deploys)
			.filter((label) => !label.includes('redirect'))
			.map((label) =>
				label
					.replaceAll(`traefik.http.routers.${appName}`, `traefik.http.routers.${tempName}`)
					.replaceAll(`traefik.http.services.${appName}`, `traefik.http.services.${tempName}`)
					.replace(/Host\(`[^`]+`\)/g, `Host(\`${hostname}\`)`),
			);
	}

	// Convert all bind mounts to named volumes
	if (service.volumes) {
		service.volumes = service.volumes.map((vol) => {
			if (typeof vol !== 'string') {
				if (vol?.type === 'volume' && typeof vol.source === 'string') {
					volumeNames.add(vol.source);
				}
				return vol;
			}

			const [hostPath, ...rest] = vol.split(':');
			const containerPath = rest.join(':');

			// Skip non-absolute paths (already named volumes)
			if (!path.isAbsolute(hostPath)) {
				const volumeName = namedVolumeFromString(vol);
				if (volumeName) volumeNames.add(volumeName);
				return vol;
			}

			const volName = hostPath.split('/').filter(Boolean).pop() || 'data';

			volumeNames.add(volName);
			return `${volName}:${containerPath}`;
		});
	}
}

pruneNetworks();
pruneVolumes(volumeNames);

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
