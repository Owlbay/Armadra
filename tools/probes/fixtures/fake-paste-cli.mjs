// 探针用的假终端 Agent（契约 §55）：像 Claude Code / Codex 那样打开括号粘贴
// （`ESC[?2004h`），把收到的每一段粘贴与每一个回车如实报出来：
//
//   PASTE<…>   一段括号粘贴的正文
//   ENTER      收到了回车（粘贴之外）
//   KEYS<…>    粘贴之外的别的按键
//
// 探针据此断言：路径是经括号粘贴进来的、一个文件一段、没有替人按回车。Ctrl+C 退出。
const input = process.stdin;
if (input.isTTY) input.setRawMode(true);
process.stdout.write("\u001b[?2004h");
process.stdout.write("fake-paste ready\r\n");

const START = "\u001b[200~";
const END = "\u001b[201~";
let buffer = "";

function loose(text) {
  if (text === "") return;
  if (text.includes("\u0003")) {
    process.stdout.write("\u001b[?2004l");
    process.exit(0);
  }
  if (/[\r\n]/.test(text)) process.stdout.write("ENTER\r\n");
  const keys = text.replace(/[\r\n]/g, "");
  if (keys !== "") process.stdout.write(`KEYS<${JSON.stringify(keys)}>\r\n`);
}

input.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const start = buffer.indexOf(START);
    if (start < 0) {
      loose(buffer);
      buffer = "";
      return;
    }
    const end = buffer.indexOf(END, start);
    if (end < 0) {
      loose(buffer.slice(0, start));
      buffer = buffer.slice(start);
      return;
    }
    loose(buffer.slice(0, start));
    process.stdout.write(
      `PASTE<${buffer.slice(start + START.length, end)}>\r\n`,
    );
    buffer = buffer.slice(end + END.length);
  }
});
