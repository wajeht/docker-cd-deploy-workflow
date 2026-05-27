import { describe, it } from 'node:test';
import assert from 'node:assert';
import { imageRepository, updateComposeImageTag } from './update-tag.js';

describe('imageRepository', () => {
	it('removes tags and digests', () => {
		assert.strictEqual(imageRepository('ghcr.io/wajeht/app:old@sha256:abc'), 'ghcr.io/wajeht/app');
		assert.strictEqual(imageRepository('ghcr.io/wajeht/app@sha256:abc'), 'ghcr.io/wajeht/app');
		assert.strictEqual(imageRepository('ghcr.io/wajeht/app'), 'ghcr.io/wajeht/app');
	});
});

describe('updateComposeImageTag', () => {
	it('updates only the requested service image', () => {
		const content = [
			'# keep this comment',
			'services:',
			'  web:',
			'    image: ghcr.io/wajeht/web:old',
			'  worker:',
			'    image: ghcr.io/wajeht/web:old',
			'',
		].join('\n');

		const result = updateComposeImageTag(content, {
			serviceName: 'web',
			repo: 'wajeht/web',
			tag: 'new',
			digest: 'sha256:def',
		});

		assert.strictEqual(result.changed, true);
		assert.strictEqual(
			result.content,
			[
				'# keep this comment',
				'services:',
				'  web:',
				'    image: ghcr.io/wajeht/web:new@sha256:def',
				'  worker:',
				'    image: ghcr.io/wajeht/web:old',
				'',
			].join('\n'),
		);
	});

	it('drops stale image digests when updating the tag', () => {
		const content = ['services:', '  web:', '    image: ghcr.io/wajeht/web:old@sha256:abc', ''].join('\n');

		const result = updateComposeImageTag(content, {
			serviceName: 'web',
			repo: 'wajeht/web',
			tag: 'new',
			digest: 'sha256:def',
		});

		assert.strictEqual(
			result.content,
			['services:', '  web:', '    image: ghcr.io/wajeht/web:new@sha256:def', ''].join('\n'),
		);
	});

	it('is a no-op when already at the tag and digest', () => {
		const content = ['services:', '  web:', '    image: ghcr.io/wajeht/web:new@sha256:def', ''].join('\n');

		const result = updateComposeImageTag(content, {
			serviceName: 'web',
			repo: 'wajeht/web',
			tag: 'new',
			digest: 'sha256:def',
		});

		assert.strictEqual(result.changed, false);
		assert.strictEqual(result.content, content);
	});

	it('does not update a service with a different image repo', () => {
		const content = ['services:', '  web:', '    image: nginx:latest', ''].join('\n');

		const result = updateComposeImageTag(content, {
			serviceName: 'web',
			repo: 'wajeht/web',
			tag: 'new',
			digest: 'sha256:def',
		});

		assert.strictEqual(result.changed, false);
		assert.strictEqual(result.content, content);
	});

	it('fails when the requested service is missing', () => {
		assert.throws(
			() =>
				updateComposeImageTag('services:\n  db:\n    image: postgres\n', {
					serviceName: 'web',
					repo: 'wajeht/web',
					tag: 'new',
					digest: 'sha256:def',
				}),
			/Service "web" not found/,
		);
	});
});
