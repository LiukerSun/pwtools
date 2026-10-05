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
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/node_modules/react-screenshots/lib/Screenshots/index.js')) return null;
      // 0.6.1 has no API for selecting native window bounds. Extend the pinned
      // container at build time while retaining its crop/resize/annotation UI.
      const anchor = '    const onDoubleClick = useCallback';
      if (!code.includes(anchor) || !code.includes('const [bounds, setBounds] = useState(null)')) {
        this.error('react-screenshots 0.6.1 selection adapter no longer matches the installed package.');
      }
      const bridge = `    const externalBounds = props.selectionBounds;
    useLayoutEffect(() => {
        if (externalBounds === undefined) return;
        if (externalBounds === null) reset();
        else setBounds(externalBounds);
    }, [externalBounds, reset]);
    useLayoutEffect(() => { call('onBoundsChange', bounds); }, [bounds, call]);
`;
      return { code: code.replace(anchor, bridge + anchor), map: null };
    },
  };
}
