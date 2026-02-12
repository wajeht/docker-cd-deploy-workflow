const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const args = parseArgs(process.argv.slice(2));

const required = ['app-path', 'tag', 'pr-number', 'repo-owner'];
for (const key of required) {
	if (!args[key]) {
		console.error(`Missing required arg: --${key}`);
		process.exit(1);
	}
}

const appPath = args['app-path'];
const tag = args['tag'];
const prNumber = args['pr-number'];
const repoOwner = args['repo-owner'];
const domain = args['domain'] || 'jaw.dev';
const dataDir = args['data-dir'] || '/home/jaw/data';

const appName = path.basename(appPath);
const tempName = `${appName}-pr-${prNumber}`;
const tempPath = `${appPath}-pr-${prNumber}`;
const hostname = `pr-${prNumber}-${appName}.${domain}`;

// Copy app directory
fs.rmSync(tempPath, { recursive: true, force: true });
fs.cpSync(appPath, tempPath, { recursive: true });

// Parse compose
const composePath = path.join(tempPath, 'docker-compose.yml');
const doc = yaml.load(fs.readFileSync(composePath, 'utf8'));

const volumeNames = new Set();

for (const [, service] of Object.entries(doc.services)) {
	// Rewrite our ghcr.io image tag
	if (service.image && service.image.startsWith(`ghcr.io/${repoOwner}/`)) {
		const imageName = service.image.split(':')[0];
		service.image = `${imageName}:${tag}`;
	}

	// Rewrite traefik labels
	if (service.labels) {
		service.labels = service.labels.map((label) => {
			return label
				.replaceAll(`traefik.http.routers.${appName}`, `traefik.http.routers.${tempName}`)
				.replaceAll(`traefik.http.services.${appName}`, `traefik.http.services.${tempName}`)
				.replaceAll(`${appName}.${domain}`, hostname);
		});
	}

	// Convert bind mounts to named volumes
	if (service.volumes) {
		service.volumes = service.volumes.map((vol) => {
			if (typeof vol !== 'string') return vol;

			const [hostPath, ...rest] = vol.split(':');
			const containerPath = rest.join(':');
			const prefix = `${dataDir}/${appName}`;

			if (!hostPath.startsWith(prefix)) return vol;

			// /home/jaw/data/bang → data
			// /home/jaw/data/bang/subdir → data-subdir
			const subpath = hostPath.slice(prefix.length);
			const volName = subpath ? `data${subpath.replaceAll('/', '-')}` : 'data';

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

// If .enc-temp.env exists, add it to env_file list (overrides .enc.env values)
const tempEnvFile = '.enc-temp.env';
if (fs.existsSync(path.join(tempPath, tempEnvFile))) {
	for (const [, service] of Object.entries(doc.services)) {
		if (service.env_file) {
			const files = Array.isArray(service.env_file) ? service.env_file : [service.env_file];
			if (!files.includes(tempEnvFile)) {
				files.push(tempEnvFile);
			}
			service.env_file = files;
		}
	}
	console.log('Added .enc-temp.env to env_file list');
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
