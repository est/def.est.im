// 从 export_d1.ts 提取 SCHEMA 常量，生成 docs/d1_schema.sql（保持单一真源）
// 用法: bun run src/gen_d1_schema.ts
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('src/export_d1.ts', 'utf-8');
const m = src.match(/const SCHEMA = `([\s\S]*?)`;/);
if (!m) {
  console.error('export_d1.ts 中找不到 SCHEMA 常量');
  process.exit(1);
}
const schema = m[1];
const out = `-- def.est.im D1 schema（由 src/export_d1.ts 的 SCHEMA 自动生成，勿手改）
-- 重新生成: bun run src/gen_d1_schema.ts

${schema.trim()}
`;
writeFileSync('docs/d1_schema.sql', out);
console.log('docs/d1_schema.sql 已重新生成');
