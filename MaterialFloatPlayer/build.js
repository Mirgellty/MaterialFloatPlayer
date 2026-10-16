/*
 * 打包脚本：把源码打包成 BetterNCM 的 .plugin 文件（zip 包）。
 *
 *   node build.js            # 生成 dist/ 与 MaterialFloatPlayer-<version>.plugin，并安装到 C:/betterncm/plugins
 *   node build.js --no-install
 *   node build.js --dev      # 额外写入 C:/betterncm/plugins_dev，便于开发时热重载
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = __dirname;
const distDir = path.join(root, 'dist');

const template = JSON.parse(fs.readFileSync(path.join(root, 'manifest.template.json'), 'utf8'));
const windowJs = fs.readFileSync(path.join(root, 'src', 'window.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

if (windowJs.includes('</scr' + 'ipt>')) {
  throw new Error('window.js 中不能出现 </script> 字面量，否则会破坏注入的 HTML');
}

const manifest = JSON.parse(JSON.stringify(template));
const windowCode = '<scr' + 'ipt>' + windowJs + '</scr' + 'ipt>';
for (const range of Object.keys(manifest.hijacks)) {
  for (const url of Object.keys(manifest.hijacks[range])) {
    manifest.hijacks[range][url].code = windowCode;
  }
}

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(distDir, 'main.js'), mainJs);
fs.writeFileSync(path.join(distDir, 'window.js'), windowJs);

// ---- 极简 ZIP（仅存储，不做压缩），BetterNCM 使用标准解压可以正常读取
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function zipFiles(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (2024 - 1980) << 9 | (1 << 5) | 1;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

const pluginZip = zipFiles([
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
  { name: 'main.js', data: Buffer.from(mainJs, 'utf8') },
  { name: 'window.js', data: Buffer.from(windowJs, 'utf8') },
  ...(fs.existsSync(path.join(root, 'preview.png'))
    ? [{ name: 'preview.png', data: fs.readFileSync(path.join(root, 'preview.png')) }]
    : []),
]);

const pluginName = `MaterialFloatPlayer-${manifest.version}.plugin`;
const pluginPath = path.join(distDir, pluginName);
fs.writeFileSync(pluginPath, pluginZip);

const args = process.argv.slice(2);
if (!args.includes('--no-install')) {
  const pluginsDir = 'C:/betterncm/plugins';
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, pluginName), pluginZip);
  console.log('installed -> ' + path.join(pluginsDir, pluginName));
}
if (args.includes('--dev')) {
  const devDir = 'C:/betterncm/plugins_dev/MaterialFloatPlayer';
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(devDir, 'main.js'), mainJs);
  fs.writeFileSync(path.join(devDir, 'window.js'), windowJs);
  console.log('dev copy -> ' + devDir);
}

console.log('built ' + pluginPath + ' (' + pluginZip.length + ' bytes)');
