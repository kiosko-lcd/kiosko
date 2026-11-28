// Run as a script (`node --conditions=source malloc-boot-probe.ts [args]`): prints what malloc-boot left in the environment.
import '../malloc-boot.ts';
console.log(JSON.stringify({ pid: process.pid, arenaMax: process.env.MALLOC_ARENA_MAX ?? null, mark: process.env.KIOSKO_MALLOC ?? null }));
