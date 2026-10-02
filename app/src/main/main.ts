import { app } from 'electron';
import { applyIdentity } from './identity';

// First statement: every path the app owns moves to %APPDATA%\Hydra App before anything can touch the default,
// which is the IDE's %APPDATA%\Hydra. The rest of the app loads only after this line.
applyIdentity(app);

(require('./startup') as typeof import('./startup')).start();
