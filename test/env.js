/**
 * Test-wide environment, imported *first* by every test file: `index.js` reads
 * `WSM_LOG_PATH` while its module body evaluates, so this has to run before the
 * import of the plugin, not inside a hook.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.WSM_LOG_PATH = join(tmpdir(), `wsm-test-${process.pid}.log`);
