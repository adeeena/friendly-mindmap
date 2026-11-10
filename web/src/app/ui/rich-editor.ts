import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { RichDoc } from '../core/model';
import { isSafeUrl, sanitizeRichDoc } from '../core/rich-text';

export function richExtensions() {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      listKeymap: false,
      orderedList: false,
      strike: false,
      underline: false,
      trailingNode: false,
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        isAllowedUri: (url) => isSafeUrl(url),
      },
    }),
  ];
}

export type RichKeyHandler = (event: KeyboardEvent, editor: Editor) => boolean;

let linkCounter = 0;

/** Thin TipTap wrapper used by node editing and the notes panel. */
@Component({
  selector: 'bm-rich-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bm-rich-editor' },
  template: `
    @if (linkOpen()) {
      <form class="bm-link-form bm-panel" (submit)="applyLink($event)">
        <label class="visually-hidden" [attr.for]="linkId">Link URL</label>
        <input
          [id]="linkId"
          #linkInput
          type="url"
          placeholder="https://"
          [value]="linkValue()"
          (input)="linkValue.set(linkInput.value)"
          (keydown.escape)="closeLink($event)"
        />
        <button type="submit" class="bm-button">Apply</button>
        @if (linkError()) {
          <span class="bm-link-error" role="alert">Only http, https and mailto links are allowed.</span>
        }
      </form>
    }
  `,
})
export class RichEditor implements OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly content = input.required<RichDoc>();
  readonly ariaLabel = input('Text');
  readonly autofocus = input<'end' | 'all' | false>('end');
  readonly multiline = input(true);
  readonly keyHandler = input<RichKeyHandler | null>(null);
  readonly changed = output<RichDoc>();
  readonly blurred = output<void>();
  readonly ready = output<Editor>();

  protected readonly linkOpen = signal(false);
  protected readonly linkValue = signal('');
  protected readonly linkError = signal(false);
  protected readonly linkId = `bm-link-${++linkCounter}`;
  editor: Editor | null = null;

  constructor() {
    afterNextRender(() => {
      const mount = document.createElement('div');
      mount.className = 'bm-rich-mount';
      this.host.nativeElement.prepend(mount);
      this.editor = new Editor({
        element: mount,
        extensions: richExtensions(),
        content: sanitizeRichDoc(this.content()),
        autofocus: this.autofocus(),
        editorProps: {
          attributes: { 'aria-label': this.ariaLabel(), 'aria-multiline': String(this.multiline()), role: 'textbox' },
          handleKeyDown: (_view, event) => {
            if (event.isComposing || event.keyCode === 229) return false;
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
              this.openLink();
              return true;
            }
            const handler = this.keyHandler();
            return handler && this.editor ? handler(event, this.editor) : false;
          },
        },
        onUpdate: ({ editor }) => this.changed.emit(sanitizeRichDoc(editor.getJSON())),
        onBlur: ({ event }) => {
          const next = event.relatedTarget as Node | null;
          if (next && this.host.nativeElement.contains(next)) return;
          this.blurred.emit();
        },
      });
      // TipTap's autofocus is deferred; focus now so keys typed in this task land here.
      const mode = this.autofocus();
      if (mode) {
        this.editor.view.focus();
        if (mode === 'end') this.editor.commands.setTextSelection(this.editor.state.doc.content.size);
        else this.editor.commands.selectAll();
      }
      this.ready.emit(this.editor);
    });
  }

  private openLink(): void {
    const current = this.editor?.getAttributes('link')['href'];
    this.linkValue.set(typeof current === 'string' ? current : '');
    this.linkError.set(false);
    this.linkOpen.set(true);
    setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>('#' + this.linkId)?.focus());
  }

  protected applyLink(e: Event): void {
    e.preventDefault();
    const url = this.linkValue().trim();
    const chain = this.editor?.chain().focus().extendMarkRange('link');
    if (!url) {
      chain?.unsetLink().run();
    } else {
      if (!isSafeUrl(url)) {
        this.linkError.set(true);
        return;
      }
      chain?.setLink({ href: url }).run();
    }
    // TipTap's focus() is deferred; refocus now so the next key reaches the editor.
    this.editor?.view.focus();
    this.linkOpen.set(false);
  }

  protected closeLink(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    this.linkOpen.set(false);
    this.editor?.view.focus();
  }

  ngOnDestroy(): void {
    this.editor?.destroy();
  }
}
