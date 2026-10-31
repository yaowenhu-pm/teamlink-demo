import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDocument, updateDocument, serializeDocument, validateDocument} from '../dist/canvas-model.mjs';
import {revisionOf} from '../dist/collaboration-model.mjs';

// Exercise the production pure selector without importing the page's DOM bootstrap.
const source = await readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8');
const constant = source.match(/^const PROJECT_STORAGE=.*;$/m)?.[0];
const start = source.indexOf('function sharedContextKey('), end = source.indexOf('\nfunction newSharedProjectKey(');
assert.ok(constant && start >= 0 && end > start, 'the production shared-context selector must be available');
const select = new Function('serializeDocument', 'validateDocument', 'revisionOf',
  constant + '\n' + source.slice(start, end) + '\nreturn sharedContextKey;')(serializeDocument, validateDocument, revisionOf);
const legacyKey = document => 'teamlink-project-v1-shared-' + revisionOf(document);
const keyA = 'teamlink-project-v1-shared-session-first', keyB = 'teamlink-project-v1-shared-session-second';

test('a shared project keeps its stable key after document edits, persistence and reload', () => {
  const original = createDocument(), first = select(original, null, false, keyA);
  assert.equal(first.key, keyA); assert.equal(first.sameDocument, false);
  const edited = updateDocument(original, {content: {title: '改过的中文作品 🧪'}});
  const saved = JSON.parse(JSON.stringify({document: edited, baseline: original, projectKey: first.key}));
  const restored = select(edited, saved, false, keyB);
  assert.equal(restored.key, keyA); assert.equal(restored.sameDocument, true);
});

test('project-only edits can reload using the initial document association', () => {
  const document = createDocument(), first = select(document, null, false, keyA);
  const saved = {document, baseline: null, projectKey: first.key};
  assert.equal(select(document, saved, false, keyB).key, keyA);
});

test('opening a different document creates an isolated project even when a legacy key exists', () => {
  const original = createDocument(), edited = updateDocument(original, {rules: {preserveFilters: true}});
  const saved = {document: edited, baseline: original, projectKey: keyA};
  const other = select(original, saved, true, keyB);
  assert.equal(other.key, keyB); assert.equal(other.sameDocument, false);
});

test('old shared document saves and preexisting per-revision project records remain readable', () => {
  const document = createDocument();
  assert.equal(select(document, {document, baseline: null}, true, keyA).key, legacyKey(document));
  assert.equal(select(document, null, true, keyA).key, legacyKey(document));
  const stable = {document, projectKey: legacyKey(document)};
  assert.equal(select(document, stable, true, keyB).key, legacyKey(document));
});

test('untrusted keys and invalid saved snapshots cannot select unrelated browser storage', () => {
  const document = createDocument();
  const invalidKey = select(document, {document, projectKey: 'teamlink-project-v1'}, false, keyB);
  assert.equal(invalidKey.key, legacyKey(document));
  const invalidDocument = select(document, {document: {schemaVersion: 999}, projectKey: keyA}, false, keyB);
  assert.equal(invalidDocument.key, keyB); assert.equal(invalidDocument.sameDocument, false);
  assert.doesNotThrow(() => select(document, null, false, keyA));
});

test('canonical document matching tolerates JSON key order while preserving the established project key', () => {
  const document = createDocument();
  const reordered = Object.fromEntries(Object.entries(JSON.parse(serializeDocument(document))).reverse());
  const restored = select(document, {document: reordered, projectKey: keyA}, false, keyB);
  assert.equal(restored.sameDocument, true); assert.equal(restored.key, keyA);
});
