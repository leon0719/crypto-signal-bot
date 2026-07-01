import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readActive, writeActive } from "./state.js";

const dir = join(tmpdir(), "csb-state-test");
const path = join(dir, "signal-state.json");

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("state", () => {
  test("檔案不存在 → 回空陣列", async () => {
    expect(await readActive(join(dir, "nope.json"))).toEqual([]);
  });

  test("write 後 read 可還原(自動建目錄)", async () => {
    await writeActive(path, ["LINKUSDT:SHORT", "BNBUSDT:SHORT"]);
    expect((await readActive(path)).sort()).toEqual(["BNBUSDT:SHORT", "LINKUSDT:SHORT"]);
  });

  test("內容毀損 → 回空陣列(fail-soft)", async () => {
    await writeActive(path, []); // 先建目錄
    await Bun.write(path, "{壞掉的 json");
    expect(await readActive(path)).toEqual([]);
  });
});
