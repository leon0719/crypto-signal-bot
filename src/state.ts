// 去重狀態:以 JSON 檔記錄上輪有效機會的 key 集合。fail-soft:讀不到/壞掉都當空。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readActive(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { active?: unknown };
    return Array.isArray(parsed.active) ? (parsed.active as string[]) : [];
  } catch {
    return [];
  }
}

export async function writeActive(path: string, active: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = JSON.stringify({ active, updatedAt: new Date().toISOString() }, null, 2);
  await writeFile(path, body, "utf8");
}
