import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';

export interface Command {
  id: string;
  label: string;
  group: string;
  /** e.g. 'p', 'mod+z', 'mod+shift+z', 'shift+1', 'delete' */
  keys?: string[];
  run: () => void;
  enabled?: () => boolean;
  /** Fire even when focus is in a text field. */
  allowInEditable?: boolean;
  /** Hidden from the command palette. */
  hidden?: boolean;
}

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** Normalizes a keyboard event to a combo string matching `Command.keys`. */
export function eventCombo(e: KeyboardEvent, mac = isMac()): string {
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let key: string;
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Key[A-Z]$/.test(e.code) && e.key.length === 1 && !/[a-z]/i.test(e.key)) key = e.code.slice(3).toLowerCase();
  else if (e.key === '+') key = '=';
  else if (e.key === ' ') key = 'space';
  else key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (key === 'period' || key === '>') key = '.';
  parts.push(key);
  return parts.join('+');
}

export function formatKeys(keys: string, mac = isMac()): string {
  const map: Record<string, string> = mac
    ? { mod: '⌘', shift: '⇧', alt: '⌥', delete: 'Del', backspace: '⌫', escape: 'Esc' }
    : { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', delete: 'Del', backspace: 'Backspace', escape: 'Esc' };
  return keys
    .split('+')
    .map((p) => map[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join(mac ? '' : '+');
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false;
  const el = target as HTMLElement;
  if (el.isContentEditable || el.closest('[contenteditable="true"]')) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

@Injectable({ providedIn: 'root' })
export class CommandRegistry {
  readonly commands = signal<Command[]>([]);
  /** Set while a modal surface (palette/dialog) owns the keyboard. */
  readonly modalOpen = signal(false);
  /** Returns true while text is being edited somewhere (suppresses non-editable commands). */
  textEditing: () => boolean = () => false;

  register(cmds: Command[]): () => void {
    this.commands.update((list) => [...list.filter((c) => !cmds.some((n) => n.id === c.id)), ...cmds]);
    return () => this.commands.update((list) => list.filter((c) => !cmds.includes(c)));
  }

  get(id: string): Command | undefined {
    return this.commands().find((c) => c.id === id);
  }

  run(id: string): boolean {
    const c = this.get(id);
    if (!c || (c.enabled && !c.enabled())) return false;
    c.run();
    return true;
  }

  shortcutFor(id: string): string | null {
    const k = this.get(id)?.keys?.[0];
    return k ? formatKeys(k) : null;
  }

  /** True when a modified combo (Shift/Alt/Mod + key) is bound; bare characters stay typeable. */
  hasModifiedBinding(e: KeyboardEvent): boolean {
    const combo = eventCombo(e);
    return combo.includes('+') && this.commands().some((c) => c.keys?.includes(combo));
  }

  /** Returns true when the event triggered a command. */
  handleKeydown(e: KeyboardEvent): boolean {
    if (e.defaultPrevented || e.isComposing) return false;
    const combo = eventCombo(e);
    const editable = isEditableTarget(e.target) || this.textEditing();
    for (const c of this.commands()) {
      if (!c.keys?.includes(combo)) continue;
      if (editable && !c.allowInEditable) return false;
      if (this.modalOpen() && !c.allowInEditable) return false;
      if (c.enabled && !c.enabled()) return false;
      e.preventDefault();
      c.run();
      return true;
    }
    return false;
  }
}

/** Listens on the document and routes key presses to the registry. */
@Injectable({ providedIn: 'root' })
export class HotkeyService {
  private readonly registry = inject(CommandRegistry);
  private readonly document = inject(DOCUMENT);
  private listening = false;

  listen(destroyRef: DestroyRef): void {
    if (this.listening) return;
    this.listening = true;
    const handler = (e: KeyboardEvent) => this.registry.handleKeydown(e);
    this.document.addEventListener('keydown', handler);
    destroyRef.onDestroy(() => {
      this.document.removeEventListener('keydown', handler);
      this.listening = false;
    });
  }
}
