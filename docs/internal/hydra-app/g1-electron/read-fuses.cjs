// Print the fuse wire of one or more executables (read-only). Usage: node read-fuses.cjs <exe>...
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
(async () => {
  for (const exe of process.argv.slice(2)) {
    const wire = await getCurrentFuseWire(exe);
    const named = {};
    for (const [name, index] of Object.entries(FuseV1Options)) {
      if (typeof index !== 'number') continue;
      const v = wire[index];
      named[name] = v === 49 ? 'on' : v === 48 ? 'off' : v === 114 ? 'removed' : v === undefined ? 'absent' : String(v);
    }
    console.log(JSON.stringify({ exe: exe.replace(process.env.USERPROFILE, '~'), version: wire.version, fuses: named }, null, 2));
  }
})().catch(e => { console.error(e); process.exit(1); });
