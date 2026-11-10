import { Injectable, computed, signal } from '@angular/core';

/** Emojis always offered in the quick bar, in this order. */
export const QUICK_EMOJIS = ['🚩', '✅', '⚠️', '📞', '❌', '🐞', '⌛', '🔄'] as const;

export const EMOJI_STORAGE_KEY = 'friendly-mindmap.quick-emojis';
export const MAX_CUSTOM_EMOJIS = 12;

export const EMOJI_CATEGORIES: { id: string; emojis: readonly string[] }[] = [
  {
    id: 'smileys',
    emojis: '😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😍 🥰 😘 😎 🤩 🥳 🤔 🤨 😐 😴 😮 😢 😭 😡 🥺 😱 🤯 🙄 😬'.split(' '),
  },
  {
    id: 'people',
    emojis: '👍 👎 👌 ✌️ 🤞 🤝 👏 🙌 🙏 💪 👀 🧠 👋 ☝️ 👉 👈 ✍️ 🤷 🙋 👥'.split(' '),
  },
  {
    id: 'symbols',
    emojis: '✅ ❌ ⚠️ ❗ ❓ ⭐ 🚩 🏁 🔥 💡 🎯 📌 🔒 🔓 🔔 🔕 ➕ ➖ ✔️ ✖️ 🔄 ⏳ ⌛ ⏰ 🆕 🆗 ⛔ 🚫 💯 ♻️'.split(' '),
  },
  {
    id: 'hearts',
    emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟩 🟦'.split(' '),
  },
  {
    id: 'objects',
    emojis: '📞 📅 📝 📎 🔗 💬 📚 📈 📉 📊 💼 🗂️ 📁 📧 🔧 🛠️ 🧪 💻 🖥️ 📱 🔍 🔑 💰 🏷️ 📦 🗑️ 🧾 📣'.split(' '),
  },
  {
    id: 'nature',
    emojis: '🐞 🐛 🦋 🐝 🐢 🐶 🐱 🦊 🐻 🐼 🦁 🐸 🐵 🦄 🌱 🌳 🌸 🌞 🌙 ⚡ 🌈 ☔ ❄️ 🌊'.split(' '),
  },
  {
    id: 'food',
    emojis: '🍎 🍌 🍇 🍓 🍕 🍔 🍟 🌮 🍣 🍰 🍪 ☕ 🍺 🍷 🥗 🥑 🍞 🧀 🍫 🥤'.split(' '),
  },
  {
    id: 'travel',
    emojis: '🚀 ✈️ 🚗 🚲 🚆 🏠 🏢 🏖️ ⛰️ 🗺️ 🧭 🎉 🎁 🏆 🎮 🎵 🎬 ⚽ 🎨 🎲'.split(' '),
  },
];

const EMOJI_START = /^(\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)/u;

/** The first emoji in `text` (with its modifiers and joiners), or null when it does not start with one. */
export function firstEmoji(text: string): string | null {
  const input = text.trim();
  if (!input) return null;
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: 'grapheme' }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const first = Segmenter ? [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(input)][0]?.segment : Array.from(input)[0];
  return first && EMOJI_START.test(first) ? first : null;
}

function readCustom(): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(EMOJI_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === 'string' && firstEmoji(e) === e).slice(-MAX_CUSTOM_EMOJIS);
  } catch {
    return [];
  }
}

/** The quick emoji list: the fixed set, then whatever the user picked, kept in the browser. */
@Injectable({ providedIn: 'root' })
export class QuickEmojis {
  private readonly picked = signal<string[]>(readCustom());
  readonly custom = this.picked.asReadonly();
  readonly all = computed<string[]>(() => [...QUICK_EMOJIS, ...this.picked()]);

  /** Appends a picked emoji after the fixed ones; emojis already in the list stay where they are. */
  remember(emoji: string): void {
    if (this.all().includes(emoji)) return;
    this.picked.update((list) => [...list, emoji].slice(-MAX_CUSTOM_EMOJIS));
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(EMOJI_STORAGE_KEY, JSON.stringify(this.picked()));
    } catch {
      // Private mode or full storage: the list lasts for this visit only.
    }
  }
}
