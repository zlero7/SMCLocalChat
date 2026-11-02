import { migrate, pool } from '../db.js';

const applied = await migrate();
console.log(applied.length ? `적용됨: ${applied.join(', ')}` : '적용할 마이그레이션이 없어요.');
await pool.end();
