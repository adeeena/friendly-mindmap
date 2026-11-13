import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEMA_VERSION, createBoard, createNode, textDoc } from '../../shared/model';
import { NewerSchemaError, migrateBoard } from '../../shared/migrations';
import { richToHtml } from '../../shared/rich-text';
import { BoardValidationError, validateBoardDoc } from '../../shared/validate';

test('shared board contracts execute in Node without Angular or a DOM', () => {
  const doc = createBoard('Shared', 'shared');
  doc.nodes['root'] = createNode({ id: 'root', text: textDoc('A < B') });
  const stored = migrateBoard({ schemaVersion: 1, doc });
  assert.equal(stored.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(stored.doc.children['__root__'], ['root']);
  assert.equal(richToHtml(stored.doc.nodes['root']?.text), '<p>A &lt; B</p>');
});

test('server and browser use the same schema rejection and sanitization', () => {
  assert.throws(() => migrateBoard({ schemaVersion: SCHEMA_VERSION + 1 }), NewerSchemaError);
  assert.throws(() => validateBoardDoc(null), BoardValidationError);
  const doc = createBoard();
  doc.nodes['root'] = createNode({
    id: 'root',
    text: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Unsafe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
        { type: 'script', text: 'alert(1)' },
      ] }],
    },
  });
  assert.equal(richToHtml(validateBoardDoc(doc).nodes['root']?.text), '<p>Unsafe</p>');
});
