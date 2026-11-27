const { sign, verify, createPrivateKey, createPublicKey } = require('node:crypto');

const maxPackBytes = 12 * 1024 * 1024;
const stableVersion = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const domain = Buffer.from('tmc-tool renderer package v1\0');

function decode(value) {
  if (typeof value !== 'string') throw new Error('Invalid renderer encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Invalid renderer encoding');
  return bytes;
}

function validateFiles(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 512) throw new Error('Invalid renderer file count');
  const files = new Map();
  const names = new Set();
  let total = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid renderer entry');
    const [name, contents] = entry;
    if (typeof name !== 'string' || name.length > 240 ||
        !name.split('/').every((part) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) && !part.endsWith('.')) ||
        names.has(name.toLowerCase())) throw new Error('Invalid or duplicate renderer path');
    names.add(name.toLowerCase());
    const bytes = decode(contents);
    total += bytes.length;
    if (total > 6 * 1024 * 1024) throw new Error('Renderer files exceed size limit');
    files.set(name, bytes);
  }
  for (const name of names) {
    const parts = name.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (names.has(parts.join('/'))) throw new Error('Conflicting renderer path');
    }
  }
  if (!files.has('index.html')) throw new Error('Renderer entry point missing');
  return files;
}

function baseFor(version) {
  if (typeof version !== 'string' || !stableVersion.test(version)) throw new Error('Invalid renderer version');
  return version.split('.').slice(0, 2).join('.');
}

function signRenderer(version, files, key) {
  const base = baseFor(version);
  const entries = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, bytes]) => [name, bytes.toString('base64')]);
  validateFiles(entries);
  const payload = Buffer.from(JSON.stringify({ version, base, entries }));
  const privateKey = key?.type === 'private' ? key : createPrivateKey(key);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 private key');
  const signature = sign(null, Buffer.concat([domain, payload]), privateKey);
  const pack = JSON.stringify({ payload: payload.toString('base64'), signature: signature.toString('base64') });
  if (Buffer.byteLength(pack) > maxPackBytes) throw new Error('Renderer package exceeds size limit');
  return pack;
}

function verifyRenderer(pack, expectedVersion, key) {
  const base = baseFor(expectedVersion);
  if (Buffer.byteLength(pack) > maxPackBytes) throw new Error('Renderer package exceeds size limit');
  const envelope = JSON.parse(pack);
  const payload = decode(envelope.payload);
  const signature = decode(envelope.signature);
  const publicKey = key?.type === 'public' ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64 ||
      !verify(null, Buffer.concat([domain, payload]), publicKey, signature)) throw new Error('Invalid renderer signature');
  const manifest = JSON.parse(payload);
  if (manifest.version !== expectedVersion || manifest.base !== base) throw new Error('Renderer version mismatch');
  return validateFiles(manifest.entries);
}

function createRendererStore(root, installed, publicKey) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const base = baseFor(installed);
  const location = path.join(root, `${base}.json`);
  const prior = path.join(root, `${base}.previous.json`);
  const patch = (v) => Number(v.split('.')[2]);
  let active = null;
  let busy = false;

  function verified(version, pack, minimum = installed) {
    if (baseFor(version) !== base || patch(version) <= patch(minimum)) throw new Error('Incompatible renderer version');
    return { version, files: verifyRenderer(pack, version, publicKey), pack };
  }

  async function read(file) {
    try {
      const handle = await fs.open(file, 'r');
      try {
        const max = maxPackBytes + 128;
        const { size } = await handle.stat();
        if (size > max) return null;
        const bytes = Buffer.alloc(size + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== size) return null;
        const { version, pack } = JSON.parse(bytes.subarray(0, bytesRead));
        return verified(version, JSON.stringify(pack));
      } finally {
        await handle.close();
      }
    } catch { return null; }
  }

  async function write(file, value) {
    const temp = await fs.mkdtemp(path.join(root, '.renderer-'));
    try {
      const staged = path.join(temp, 'patch.json');
      await fs.writeFile(staged, `{"version":${JSON.stringify(value.version)},"pack":${value.pack}}`, { flag: 'wx', mode: 0o600 });
      await fs.rename(staged, file);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }

  return {
    get version() { return active?.version ?? installed; },
    async restore() {
      active = await read(location) ?? await read(prior);
      return active;
    },
    async rejectActive() {
      const rejected = active;
      const fallback = await read(prior);
      await fs.rm(location, { force: true });
      if (fallback?.version !== rejected?.version) {
        active = fallback;
      } else {
        await fs.rm(prior, { force: true });
        active = null;
      }
      return active;
    },
    async activate(version, pack, load) {
      if (busy) throw new Error('Renderer update already running');
      const next = verified(version, pack, active?.version ?? installed);
      const previous = active;
      busy = true;
      try {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        await load(next);
        if (previous) await write(prior, previous);
        await write(location, next);
        active = next;
      } catch (error) {
        try { await load(previous); }
        catch { await load(null); }
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}

module.exports = { baseFor, maxPackBytes, signRenderer, verifyRenderer, createRendererStore };
