// 一次性建立 LINE Rich Menu(輸入框上方的圖文選單)。
//
// 用法:
//   bun scripts/setup-richmenu.ts <CHANNEL_ACCESS_TOKEN> <圖片路徑.png>
//
// 圖片需求:2500×843(本範本為 1 列 3 格)。三格分別送出 BTC / ETH / 多週期。
// 想改格數/連結,調整下方 areas 與 bounds 即可。

const API = "https://api.line.me/v2/bot/richmenu";
const DATA_API = "https://api-data.line.me/v2/bot/richmenu";

const WIDTH = 2500;
const HEIGHT = 843;

const menu = {
  size: { width: WIDTH, height: HEIGHT },
  selected: true,
  name: "crypto-signal-bot",
  chatBarText: "查訊號",
  areas: [cell(0, "BTC"), cell(1, "ETH"), cell(2, "BTC multi")],
};

function cell(col: number, text: string) {
  const w = Math.floor(WIDTH / 3);
  return {
    bounds: { x: col * w, y: 0, width: w, height: HEIGHT },
    action: { type: "message", text },
  };
}

async function main() {
  const [token, imagePath] = process.argv.slice(2);
  if (!token || !imagePath) {
    console.error("用法: bun scripts/setup-richmenu.ts <ACCESS_TOKEN> <圖片.png>");
    process.exit(1);
  }
  const auth = { Authorization: `Bearer ${token}` };

  // 1) 建立 rich menu。
  const createRes = await fetch(API, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(menu),
  });
  if (!createRes.ok) throw new Error(`建立失敗 ${createRes.status}: ${await createRes.text()}`);
  const { richMenuId } = (await createRes.json()) as { richMenuId: string };
  console.log("richMenuId:", richMenuId);

  // 2) 上傳圖片。
  const img = await Bun.file(imagePath).arrayBuffer();
  const contentType = imagePath.endsWith(".jpg") ? "image/jpeg" : "image/png";
  const upRes = await fetch(`${DATA_API}/${richMenuId}/content`, {
    method: "POST",
    headers: { ...auth, "Content-Type": contentType },
    body: img,
  });
  if (!upRes.ok) throw new Error(`上傳圖片失敗 ${upRes.status}: ${await upRes.text()}`);

  // 3) 設為預設選單。
  const setRes = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: "POST",
    headers: auth,
  });
  if (!setRes.ok) throw new Error(`設為預設失敗 ${setRes.status}: ${await setRes.text()}`);

  console.log("✅ Rich menu 已建立並設為預設。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
