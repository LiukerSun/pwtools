import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

// The pinned 0.6.1 tarball omits the CSS imported by its library modules.
// CaptureOverlay imports the package's complete published dist stylesheet.
export function reactScreenshotsStyles(): Plugin {
  const emptyStyle = '\0pwtools-react-screenshots-style';
  return {
    name: 'react-screenshots-published-styles',
    resolveId(source, importer) {
      if (importer?.replaceAll('\\', '/').includes('/node_modules/react-screenshots/lib/')
        && source.startsWith('.') && source.endsWith('.css')
        && !existsSync(resolve(dirname(importer), source))) return emptyStyle;
      return null;
    },
    load(id) { return id === emptyStyle ? '' : null; },
  };
}
