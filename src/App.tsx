/**
 * VECTRA — the default experience is the Live Operations incident-command
 * console. The earlier scenario-first harness is preserved for development and
 * as a judge fallback at `?mode=classic`.
 */

import { LiveConsole } from './components/live/LiveConsole';
import ClassicApp from './ClassicApp';

export default function App() {
  const classic =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('mode') === 'classic';
  return classic ? <ClassicApp /> : <LiveConsole />;
}
