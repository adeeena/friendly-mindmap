import { TestBed } from '@angular/core/testing';
import { CommandRegistry, eventCombo, formatKeys } from './commands';
import { EditorStore } from './editor-store';

function key(init: KeyboardEventInit & { target?: EventTarget }): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.target) Object.defineProperty(e, 'target', { value: init.target });
  return e;
}

describe('hotkeys', () => {
  let registry: CommandRegistry;
  let store: EditorStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    registry = TestBed.inject(CommandRegistry);
    store = TestBed.inject(EditorStore);
    registry.register([
      { id: 'tool.pointer', label: 'Pointer', group: 'Tools', keys: ['p', 'v'], run: () => store.setTool('pointer') },
      { id: 'tool.hand', label: 'Hand', group: 'Tools', keys: ['h'], run: () => store.setTool('hand') },
      { id: 'undo', label: 'Undo', group: 'Edit', keys: ['mod+z'], run: () => store.undo() },
    ]);
  });

  it('H and P switch tools', () => {
    registry.handleKeydown(key({ key: 'h', code: 'KeyH' }));
    expect(store.tool()).toBe('hand');
    registry.handleKeydown(key({ key: 'p', code: 'KeyP' }));
    expect(store.tool()).toBe('pointer');
  });

  it('typing P in an editable target does not switch tools', () => {
    store.setTool('hand');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    const handled = registry.handleKeydown(key({ key: 'p', code: 'KeyP', target: editor }));
    expect(handled).toBe(false);
    expect(store.tool()).toBe('hand');
    const input = document.createElement('input');
    expect(registry.handleKeydown(key({ key: 'p', code: 'KeyP', target: input }))).toBe(false);
    editor.remove();
  });

  it('normalizes mod and shifted digits', () => {
    expect(eventCombo(key({ key: 'z', code: 'KeyZ', metaKey: true }), true)).toBe('mod+z');
    expect(eventCombo(key({ key: 'z', code: 'KeyZ', ctrlKey: true }), false)).toBe('mod+z');
    expect(eventCombo(key({ key: '!', code: 'Digit1', shiftKey: true }), false)).toBe('shift+1');
    expect(eventCombo(key({ key: 'Delete', code: 'Delete' }), false)).toBe('delete');
    expect(formatKeys('mod+shift+z', false)).toBe('Ctrl+Shift+Z');
    expect(formatKeys('mod+k', true)).toBe('⌘K');
  });
});
