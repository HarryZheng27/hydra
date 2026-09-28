// A stand-in agent that fails before doing anything, like one that isn't installed or signed in.
'use strict';
process.stderr.write('not signed in');
process.exitCode = 1;
