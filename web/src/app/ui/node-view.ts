import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { Editor } from '@tiptap/core';
import { childrenOf } from '../core/commands';
import { textDoc } from '../core/model';
import { isRichEmpty, richToHtml } from '../core/rich-text';
import { EditorStore, newTxn } from '../editor/editor-store';
import { CommandRegistry, isMac } from '../editor/commands';
import { t } from '../i18n';
import { checklistOf, checklistProgress } from '../io/checklist-export';
import { ChecklistItems } from './checklist-items';
import { Icon } from './icon';
import { RichEditor } from './rich-editor';

/** Parses a type-ahead token ('a', 'Shift+Tab', 'Mod-Shift-z') into keyboard event fields. */
export function tokenToKey(token: string): KeyboardEventInit & { key: string } {
  if (token.startsWith('Mod-') || token.startsWith('Alt-')) {
    const parts = token.split('-');
    const mod = parts.includes('Mod');
    return {
      key: parts[parts.length - 1],
      metaKey: mod && isMac(),
      ctrlKey: mod && !isMac(),
      altKey: parts.includes('Alt'),
      shiftKey: parts.includes('Shift'),
    };
  }
  return token.startsWith('Shift+') ? { key: token.slice(6), shiftKey: true } : { key: token };
}

/** Runs a buffered key through the editor's keymaps; caret keys fall back to explicit moves. */
function replayEditorKey(editor: Editor, token: string): void {
  const init = tokenToKey(token);
  const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
  const view = editor.view;
  if (view.someProp('handleKeyDown', (f) => f(view, event))) return;
  const { from } = view.state.selection;
  const end = view.state.doc.content.size;
  const caret: Record<string, number> = {
    End: end,
    ArrowDown: end,
    Home: 0,
    ArrowUp: 0,
    ArrowLeft: Math.max(0, from - 1),
    ArrowRight: Math.min(end, from + 1),
  };
  if (init.key in caret) editor.commands.setTextSelection(caret[init.key]);
}

@Component({
  selector: 'bm-node',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RichEditor, ChecklistItems, Icon],
  host: {
    class: 'bm-node',
    role: 'treeitem',
    '[attr.data-node-id]': 'nodeId()',
    '[attr.aria-level]': 'level()',
    '[attr.aria-setsize]': 'siblings().length',
    '[attr.aria-posinset]': 'siblings().indexOf(nodeId()) + 1',
    '[attr.aria-expanded]': 'hasChildren() ? !node().collapsed : null',
    '[attr.aria-selected]': 'selected()',
    '[attr.aria-label]': 'ariaLabel()',
    '[attr.tabindex]': 'tabbable() ? 0 : -1',
    '[class]': '"shape-" + style().shape',
    '[class.selected]': 'selected()',
    '[class.editing]': 'editing()',
    '[class.dimmed]': 'dimmed()',
    '[class.drop-target]': 'dropTarget()',
    '[class.ghost]': 'ghost()',
    '[class.animate]': 'animate()',
    '[class.colored]': '!!style().color',
    '[class.checklist]': 'node().kind === "checklist"',
    '[style.--node-color]': 'style().color ? "var(--c-" + style().color + ")" : null',
    '[style.transform]': 'transform()',
    '(focus)': 'onFocus()',
    '(keydown)': 'onKeydown($event)',
  },
  template: `
    <div class="bm-node-body">
      @if (todoParent()) {
        <input
          type="checkbox"
          class="bm-check"
          [checked]="!!node().checked"
          [disabled]="store.readOnly()"
          [attr.aria-label]="t('node.done', { text: label() })"
          (change)="toggleChecked($event)"
          (click)="$event.stopPropagation()"
        />
      }
      @if (style().emoji) {
        <span class="bm-emoji" aria-hidden="true">{{ style().emoji }}</span>
      }
      @if (editing()) {
        @for (session of [store.editSession()]; track session) {
          <bm-rich-editor
            class="bm-text"
            [ariaLabel]="t('node.text')"
            [content]="editContent()"
            [keyHandler]="keyHandler"
            (ready)="onEditorReady($event)"
            (changed)="onText($event)"
            (blurred)="onBlur()"
          />
        }
      } @else if (empty()) {
        <div class="bm-text placeholder" aria-hidden="true">{{ node().kind === 'checklist' ? t('node.checklist') : t('node.untitled') }}</div>
      } @else {
        <div class="bm-text" [innerHTML]="html()"></div>
      }
    </div>
    @if (node().kind === 'checklist') {
      <bm-checklist-items [nodeId]="nodeId()" [items]="node().items ?? []" [label]="label()" />
    }
    @if (tagChips().length || badges()) {
      <div class="bm-node-meta">
        @for (tag of tagChips(); track tag.id) {
          <span class="bm-chip" [style.--chip]="'var(--c-' + tag.color + ')'">{{ tag.name }}</span>
        }
        @if (progress(); as p) {
          <span class="bm-badge" [attr.aria-label]="t('node.ariaProgress', { done: p.done, total: p.total })">{{ p.done }}/{{ p.total }}</span>
        }
        @if (hasNote()) {
          <button type="button" class="bm-badge bm-badge-btn" [attr.aria-label]="t('node.openNote')" (click)="openNotes($event)">
            <bm-icon name="notes" [size]="14" />
          </button>
        }
        @if (node().attachments?.length) {
          <button
            type="button"
            class="bm-badge bm-badge-btn"
            [attr.aria-label]="t('node.attachmentCount', { n: node().attachments!.length })"
            (click)="openNotes($event)"
          >
            <bm-icon name="attach" [size]="14" />{{ node().attachments!.length }}
          </button>
        }
      </div>
    }
    @if (hasChildren()) {
      <button
        type="button"
        class="bm-collapse"
        [class]="'side-' + childSide()"
        [class.is-collapsed]="node().collapsed"
        tabindex="-1"
        [attr.aria-label]="node().collapsed ? t('node.expand', { n: descendantCount() }) : t('node.collapse')"
        (pointerdown)="$event.stopPropagation()"
        (click)="toggleCollapse($event)"
      >
        {{ node().collapsed ? descendantCount() : '−' }}
      </button>
    }
    @if (showHandles()) {
      <button
        type="button"
        class="bm-handle"
        [class]="'side-' + childSide()"
        tabindex="-1"
        [attr.aria-label]="t('node.addChild')"
        (pointerdown)="$event.stopPropagation()"
        (click)="addChild($event)"
      >
        <bm-icon name="plus" [size]="14" />
      </button>
      <button
        type="button"
        class="bm-handle"
        [class]="'side-' + siblingSide()"
        tabindex="-1"
        [attr.aria-label]="t('node.addSibling')"
        (pointerdown)="$event.stopPropagation()"
        (click)="addSibling($event)"
      >
        <bm-icon name="plus" [size]="14" />
      </button>
    }
  `,
})
export class NodeView {
  protected readonly t = t;
  protected readonly store = inject(EditorStore);
  private readonly registry = inject(CommandRegistry);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly nodeId = input.required<string>();

  protected readonly node = computed(() => this.store.doc().nodes[this.nodeId()]);
  protected readonly style = computed(() => this.store.styles()[this.nodeId()] ?? { shape: 'rounded', tags: [] });
  protected readonly rect = computed(() => this.store.displayRects().get(this.nodeId()));
  protected readonly transform = computed(() => {
    const r = this.rect();
    return r ? `translate(${r.x}px, ${r.y}px)` : null;
  });
  protected readonly selected = computed(() => this.store.selection().has(this.nodeId()));
  protected readonly editing = computed(() => this.store.editingId() === this.nodeId());
  protected readonly siblings = computed(() => childrenOf(this.store.doc(), this.node()?.parentId ?? null));
  protected readonly hasChildren = computed(() => childrenOf(this.store.doc(), this.nodeId()).length > 0);
  protected readonly level = computed(() => {
    let d = 1;
    let cur = this.node()?.parentId;
    const nodes = this.store.doc().nodes;
    while (cur) {
      d++;
      cur = nodes[cur]?.parentId ?? null;
    }
    return d;
  });
  protected readonly label = computed(() => this.store.label(this.nodeId()));
  protected readonly empty = computed(() => isRichEmpty(this.node()?.text));
  protected readonly html = computed(() => richToHtml(this.node()?.text));
  protected readonly dimmed = computed(() => {
    const m = this.store.filterMatches();
    return !!m && !m.has(this.nodeId());
  });
  protected readonly ghost = computed(() => !!this.store.dragPreview()?.ids.includes(this.nodeId()));
  protected readonly dropTarget = computed(() => this.store.dropTarget()?.parentId === this.nodeId());
  protected readonly animate = computed(
    () => this.store.settings().autoAlign && !this.store.dragging() && !this.ghost(),
  );
  protected readonly todoParent = computed(() => {
    const p = this.node()?.parentId;
    return !!p && !!this.store.doc().nodes[p]?.todo;
  });
  protected readonly progress = computed(() => {
    const c = checklistOf(this.store.doc(), this.nodeId());
    return c && c.items.length ? checklistProgress(c) : null;
  });
  protected readonly hasNote = computed(() => !isRichEmpty(this.node()?.note));
  protected readonly tagChips = computed(() => {
    const tags = this.store.doc().tags;
    return this.style().tags.map((t) => tags[t]).filter((t) => !!t);
  });
  protected readonly badges = computed(() => !!this.progress() || this.hasNote() || !!this.node()?.attachments?.length);
  protected readonly descendantCount = computed(() => {
    const doc = this.store.doc();
    let n = 0;
    const stack = [...childrenOf(doc, this.nodeId())];
    while (stack.length) {
      n++;
      stack.push(...childrenOf(doc, stack.pop()!));
    }
    return n;
  });
  protected readonly tabbable = computed(() => {
    const primary = this.store.primaryId();
    if (primary) return primary === this.nodeId();
    return this.store.visibleIds()[0] === this.nodeId();
  });
  protected readonly ariaLabel = computed(() => {
    const parts = [this.label()];
    if (this.node()?.kind === 'checklist') parts.push(t('node.ariaChecklist'));
    if (this.todoParent()) parts.push(this.node()?.checked ? t('node.ariaDone') : t('node.ariaNotDone'));
    const p = this.progress();
    if (p) parts.push(t('node.ariaProgress', { done: p.done, total: p.total }));
    if (this.node()?.collapsed) parts.push(t('node.ariaHidden', { n: this.descendantCount() }));
    return parts.join(', ');
  });

  /** Which side children grow toward (for handles and the collapse toggle). */
  protected readonly childSide = computed(() => {
    const dir = this.store.settings().direction;
    if (dir === 'vertical') return 'bottom';
    if (dir === 'balanced') {
      const rects = this.store.rects();
      let rootId = this.nodeId();
      const nodes = this.store.doc().nodes;
      while (nodes[rootId]?.parentId) rootId = nodes[rootId].parentId!;
      const me = rects.get(this.nodeId());
      const root = rects.get(rootId);
      if (me && root && rootId !== this.nodeId() && me.x + me.w / 2 < root.x + root.w / 2) return 'left';
    }
    return 'right';
  });
  protected readonly siblingSide = computed(() => (this.store.settings().direction === 'vertical' ? 'right' : 'bottom'));
  protected readonly showHandles = computed(
    () =>
      this.selected() &&
      this.store.selection().size === 1 &&
      !this.editing() &&
      !this.store.readOnly() &&
      this.store.tool() === 'pointer' &&
      !this.store.dragging() &&
      this.node()?.kind !== 'checklist',
  );

  protected readonly editContent = computed(() => {
    const seed = this.store.editSeed();
    return seed !== null ? textDoc(seed) : this.node().text;
  });

  private txn = newTxn('text');

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.host.nativeElement;
      const report = () => this.store.reportSize(this.nodeId(), { w: el.offsetWidth, h: el.offsetHeight });
      report();
      const ro = new ResizeObserver(report);
      ro.observe(el);
      destroyRef.onDestroy(() => ro.disconnect());
    });
    // Keep keyboard focus on the primary node when it changes inside the canvas.
    afterRenderEffect(() => {
      const primary = this.store.primaryId() === this.nodeId() && this.store.selection().size === 1;
      if (!primary || this.editing()) return;
      const el = this.host.nativeElement;
      const active = el.ownerDocument.activeElement;
      const inCanvas = !active || active === el.ownerDocument.body || !!active.closest?.('.bm-viewport');
      if (inCanvas && active !== el) el.focus({ preventScroll: true });
    });
    effect(() => {
      this.store.editSession();
      if (this.editing()) {
        const seed = this.store.editSeed();
        untracked(() => {
          this.txn = newTxn('text');
          if (seed !== null) this.store.commitText(this.nodeId(), textDoc(seed), this.txn);
        });
      } else if (untracked(() => this.store.drainTypeAhead && !this.store.editingId())) {
        this.store.drainTypeAhead = null;
      }
    });
  }

  protected onFocus(): void {
    if (!this.selected() && !this.editing()) this.store.select([this.nodeId()]);
  }

  protected onText(doc: ReturnType<typeof textDoc>): void {
    this.store.commitText(this.nodeId(), doc, this.txn);
  }

  protected onBlur(): void {
    if (this.editing()) this.store.endEdit();
  }

  /** Replays keys typed before the editor existed (fast typing after Tab/Enter/N). */
  protected onEditorReady(editor: Editor): void {
    const session = this.store.editSession();
    const drain = () => {
      if (session === this.store.editSession()) this.replayTypeAhead(editor);
    };
    this.store.drainTypeAhead = drain;
    drain();
  }

  private replayTypeAhead(editor: Editor): void {
    if (!this.editing() || editor.isDestroyed) return;
    const queue = this.store.typeAhead;
    let text = '';
    const flush = () => {
      if (text) editor.commands.insertContent(text);
      text = '';
    };
    while (queue.length) {
      const token = queue.shift()!;
      if (token.length === 1) {
        text += token;
        continue;
      }
      flush();
      if (!['Tab', 'Shift+Tab', 'Enter', 'Escape'].includes(token)) {
        replayEditorKey(editor, token);
        continue;
      }
      const [shift, key] = token.startsWith('Shift+') ? [true, token.slice(6)] : [false, token];
      this.store.replaying = true;
      try {
        this.keyHandler(new KeyboardEvent('keydown', { key, shiftKey: shift }), editor);
      } finally {
        this.store.replaying = false;
      }
      if (!this.editing()) {
        if (!this.store.editingId()) this.redispatchTypeAhead();
        return;
      }
    }
    flush();
  }

  /** Editing ended mid-queue: feed the remaining keys to the focused element as normal key presses. */
  private redispatchTypeAhead(): void {
    const doc = this.host.nativeElement.ownerDocument;
    const queue = this.store.typeAhead;
    while (queue.length && !this.store.editingId()) {
      const init = tokenToKey(queue.shift()!);
      this.store.replaying = true;
      try {
        (doc.activeElement ?? doc.body).dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
      } finally {
        this.store.replaying = false;
      }
    }
  }

  private finishEditing(): void {
    this.store.endEdit();
    this.host.nativeElement.focus({ preventScroll: true });
  }

  protected readonly keyHandler = (e: KeyboardEvent, _editor: Editor): boolean => {
    const id = this.nodeId();
    if (e.key === 'Tab' && !e.shiftKey) {
      this.store.endEdit();
      this.store.addChild(id);
      return true;
    }
    if (e.key === 'Tab' && e.shiftKey) {
      this.store.promote(id);
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.store.endEdit();
      this.store.addSibling(id);
      return true;
    }
    if (e.key === 'Escape') {
      this.finishEditing();
      return true;
    }
    return false;
  };

  protected onKeydown(e: KeyboardEvent): void {
    if (e.target !== this.host.nativeElement || this.editing() || e.isComposing) return;
    const s = this.store;
    const id = this.nodeId();
    const mod = e.metaKey || e.ctrlKey;
    if (s.readOnly() && !e.key.startsWith('Arrow')) return;
    switch (e.key) {
      case 'Tab':
        if (s.selection().size !== 1) return;
        e.preventDefault();
        if (e.shiftKey) s.promote(id);
        else s.addChild(id);
        return;
      case 'Enter':
        if (mod || e.altKey) return;
        e.preventDefault();
        if (e.shiftKey) return;
        s.addSibling(id);
        return;
      case 'F2':
        e.preventDefault();
        s.beginEdit(id);
        return;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        e.preventDefault();
        if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          s.reorder(e.key === 'ArrowUp' ? -1 : 1, id);
        } else if (e.altKey) {
          this.nudge(e.key, e.shiftKey ? 80 : 8);
        } else {
          this.navigate(e.key);
        }
        return;
    }
    if (e.key.length === 1 && !mod && !e.altKey && e.key !== ' ' && s.tool() === 'pointer' && !this.registry.hasModifiedBinding(e)) {
      e.preventDefault();
      s.beginEdit(id, e.key);
    }
  }

  private nudge(key: string, step: number): void {
    const s = this.store;
    if (s.settings().autoAlign) return;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    const doc = s.doc();
    const ids = s.selectedIds();
    const next = new Map(ids.map((id) => [id, { x: doc.nodes[id].x + dx, y: doc.nodes[id].y + dy }]));
    s.moveNodes(ids, next, newTxn('nudge'));
  }

  private navigate(key: string): void {
    const s = this.store;
    const doc = s.doc();
    const id = this.nodeId();
    const node = doc.nodes[id];
    const dir = s.settings().direction;
    const side = this.childSide();
    const towardChild =
      dir === 'vertical' ? 'ArrowDown' : side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    const towardParent =
      dir === 'vertical' ? 'ArrowUp' : side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const prevKey = dir === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const nextKey = dir === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    let target: string | null = null;
    if (key === towardChild) {
      const kids = childrenOf(doc, id);
      if (kids.length && node.collapsed) s.toggleCollapse(id);
      target = kids[0] ?? null;
    } else if (key === towardParent) {
      target = node.parentId;
    } else if (key === prevKey || key === nextKey) {
      const sib = childrenOf(doc, node.parentId);
      const idx = sib.indexOf(id) + (key === prevKey ? -1 : 1);
      target = sib[idx] ?? null;
    }
    if (target) {
      s.select([target]);
      s.revealNode(target);
      // Focus now (not via effect) so rapid key repeats continue from the new node.
      this.host.nativeElement.ownerDocument
        .querySelector<HTMLElement>(`[data-node-id="${CSS.escape(target)}"]`)
        ?.focus({ preventScroll: true });
    }
  }

  protected toggleChecked(e: Event): void {
    this.store.setChecked(this.nodeId(), (e.target as HTMLInputElement).checked);
  }

  protected toggleCollapse(e: Event): void {
    e.stopPropagation();
    this.store.toggleCollapse(this.nodeId());
  }

  protected addChild(e: Event): void {
    e.stopPropagation();
    this.store.addChild(this.nodeId());
  }

  protected addSibling(e: Event): void {
    e.stopPropagation();
    this.store.addSibling(this.nodeId());
  }

  protected openNotes(e: Event): void {
    e.stopPropagation();
    this.store.select([this.nodeId()]);
    this.store.notesOpen.set(true);
  }
}
