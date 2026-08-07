import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// 从 import.meta.dir 向上查找 .env.dev（项目根），不打印 token 内容
export function loadEnv(filename = ".env.dev"): Record<string, string> {
  const env: Record<string, string> = {};
  let dir = import.meta.dir;
  for (;;) {
    const p = join(dir, filename);
    try {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      break;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return env;
}
