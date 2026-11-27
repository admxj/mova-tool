const fs = require('node:fs/promises');
const path = require('node:path');
const { createPrivateKey, createPublicKey } = require('node:crypto');
const { signRenderer, verifyRenderer } = require('../renderer-update');

async function collect(root, dir = root, files = new Map()) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(root, name, files);
    else if (entry.isFile()) files.set(path.relative(root, name).split(path.sep).join('/'), await fs.readFile(name));
    else throw new Error('Renderer directory contains a non-regular file');
  }
  return files;
}

async function main() {
  const [version, output] = process.argv.slice(2);
  const secret = process.env.TMC_RENDERER_SIGNING_KEY;
  const anchor = process.env.TMC_RENDERER_PUBLIC_KEY;
  if (!version || !output || !secret || !anchor) throw new Error('Version, output and signing environment are required');
  const key = createPrivateKey(secret);
  const publicKey = createPublicKey(anchor);
  const pack = signRenderer(version, await collect(path.resolve(__dirname, '../renderer')), key);
  verifyRenderer(pack, version, publicKey);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, pack, { flag: 'wx' });
}

if (require.main === module) main().catch(() => {
  console.error('无法签名前端补丁：请检查版本、文件限制，以及发布环境中的 Ed25519 密钥是否匹配。');
  process.exitCode = 1;
});
