/*
 * 把 src/window.js 中的非 ASCII 字符转成 \uXXXX 转义。
 * 注入到网易云页面里的这段代码会经过 manifest.json 传递，转义可以避免编码差异导致的乱码。
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'window.js');
let src = fs.readFileSync(file, 'utf8');
let changed = 0;

src = src.replace(/[^\x00-\x7f]/g, (ch) => {
  changed += 1;
  const code = ch.codePointAt(0);
  if (code > 0xffff) {
    const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
    const low = ((code - 0x10000) % 0x400) + 0xdc00;
    return '\\u' + high.toString(16).padStart(4, '0') + '\\u' + low.toString(16).padStart(4, '0');
  }
  return '\\u' + code.toString(16).padStart(4, '0');
});

fs.writeFileSync(file, src);
console.log('escaped ' + changed + ' non-ascii characters in src/window.js');
