import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { isObject, parseArgs, runMain } from './utils.js';

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function imageRepository(image) {
	const withoutDigest = image.split('@')[0];
	const lastSlash = withoutDigest.lastIndexOf('/');
	const tagIndex = withoutDigest.indexOf(':', lastSlash + 1);
	return tagIndex === -1 ? withoutDigest : withoutDigest.slice(0, tagIndex);
}

function replaceServiceImageLine(content, serviceName, image) {
	const lines = content.split('\n');
	const servicesLine = lines.findIndex((line) => /^(\s*)services:\s*(?:#.*)?$/.test(line));
	if (servicesLine === -1) {
		throw new Error('docker-compose.yml must contain a services block');
	}

	const servicesIndent = lines[servicesLine].match(/^(\s*)/)?.[1].length ?? 0;
	const servicePattern = new RegExp(`^(\\s*)${escapeRegExp(serviceName)}:\\s*(?:#.*)?$`);
	let serviceLine = -1;
	let serviceIndent = -1;

	for (let i = servicesLine + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		if (indent <= servicesIndent) break;

		const match = line.match(servicePattern);
		if (match) {
			serviceLine = i;
			serviceIndent = match[1].length;
			break;
		}
	}

	if (serviceLine === -1) {
		throw new Error(`Service "${serviceName}" not found in docker-compose.yml`);
	}

	for (let i = serviceLine + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '') continue;
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		if (indent <= serviceIndent) break;
		if (/^\s*image:\s*/.test(line)) {
			lines[i] = `${line.match(/^(\s*)/)?.[1] ?? ''}image: ${image}`;
			return lines.join('\n');
		}
	}

	throw new Error(`Service "${serviceName}" must define an image`);
}

export function updateComposeImageTag(content, { serviceName, repo, tag }) {
	const doc = yaml.load(content);
	if (!isObject(doc) || !isObject(doc.services)) {
		throw new Error('docker-compose.yml must contain a services block');
	}

	const service = doc.services[serviceName];
	if (!isObject(service)) {
		throw new Error(`Service "${serviceName}" not found in docker-compose.yml`);
	}
	if (typeof service.image !== 'string') {
		throw new Error(`Service "${serviceName}" must define an image`);
	}

	const repoName = imageRepository(service.image);
	const expectedRepo = `ghcr.io/${repo}`.toLowerCase();
	if (repoName.toLowerCase() !== expectedRepo) {
		return {
			changed: false,
			content,
			image: service.image,
			reason: `service image is ${repoName}, expected ${expectedRepo}`,
		};
	}

	const nextImage = `${repoName}:${tag}`;
	if (service.image === nextImage) {
		return { changed: false, content, image: service.image, reason: `already at ${tag}` };
	}

	return {
		changed: true,
		content: replaceServiceImageLine(content, serviceName, nextImage),
		image: nextImage,
		previousImage: service.image,
	};
}

export async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv, { required: ['app-path', 'service-name', 'tag', 'repo'] });
	const { 'app-path': appPath, 'service-name': serviceName, tag, repo } = args;
	const composePath = path.join(appPath, 'docker-compose.yml');
	const content = fs.readFileSync(composePath, 'utf8');
	const result = updateComposeImageTag(content, { serviceName, repo, tag });

	if (!result.changed) {
		console.log(`No changes - ${result.reason}`);
		return;
	}

	fs.writeFileSync(composePath, result.content);
	console.log(`Updated ${serviceName} to ${result.image} in ${composePath}`);
}

runMain(import.meta.url, main);
