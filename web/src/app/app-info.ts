import { version } from '../../package.json';

/** Application identity shown in the UI; change `name` here to rebrand. */
export const APP_INFO = {
  name: 'Friendly Mindmap',
  version,
  homepage: 'https://adena.dev',
  author: 'Muráncsik Adéna Auróra',
} as const;
