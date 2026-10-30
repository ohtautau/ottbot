import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
const root = resolve(process.argv[2] || '../ottlog');
const require = createRequire(join(root, 'miniprogram/package.json'));
const { build } = require('esbuild');
const lib = join(root, 'miniprogram/src/lib').replace(/\\/g, '/');
await build({ stdin: { resolveDir: lib, contents: `
export { createTodo, completeTodo } from './todo-data.ts';
export { todoQuadrants, isTodoState, isMemoState, initialTodoState, initialMemoState } from './tool-records.ts';
export { habitTimePeriod, habitTimePeriods, habitTimePeriodLabels, habitPriorities } from './habit-metadata.ts';
export { longestUncheckedHabits } from './habit-order.ts';
export { cleanState, isReminderState, emptyReminderState, hasHabitDay, habitDayIndex } from './reminder-data.ts';
export { noteStateFits, validNoteImages, MAX_NOTE_IMAGE_BYTES } from './note-image-data.ts';
` }, outfile: 'bridge/ottlog-shared.mjs', bundle: true, platform: 'node', format: 'esm', minify: true,
  banner: { js: '// Generated from Ottlog shared models. Rebuild with node bridge/build-ottlog-shared.mjs <ottlog-checkout>. Do not edit manually.' } });
