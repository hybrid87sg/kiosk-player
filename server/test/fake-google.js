// A pretend Google for the tests: a Drive folder kept in memory, and a
// sign-in checker that accepts tokens shaped like "valid:<email>".
// It has the same five functions as src/google.js, plus helpers that let a
// test act like someone dropping a file into (or removing it from) Drive.

const crypto = require('node:crypto');
const { Readable } = require('node:stream');

function createFakeGoogle() {
  const files = new Map(); // id -> { id, name, mimeType, size, md5Checksum, data }
  let nextId = 1;
  let failing = false;
  let downloads = 0;
  let uploadDims = { width: 3840, height: 2160 }; // what Drive "measures" for uploads

  // dims: { width, height } in pixels, or null while Drive is still processing.
  function addFile(name, mimeType, data, dims = { width: 3840, height: 2160 }) {
    const file = {
      id: `drive-${nextId++}`,
      name,
      mimeType,
      size: data.length,
      md5Checksum: crypto.createHash('md5').update(data).digest('hex'),
      width: dims ? dims.width : null,
      height: dims ? dims.height : null,
      data,
    };
    files.set(file.id, file);
    return file;
  }

  const meta = ({ data, ...rest }) => rest;
  const offline = () => Object.assign(new Error('Drive is unreachable'), { status: 503 });

  return {
    async verifyIdToken(idToken) {
      if (!idToken.startsWith('valid:')) throw new Error('bad token');
      return { email: idToken.slice(6) };
    },

    async listFolder() {
      if (failing) throw offline();
      return [...files.values()].map(meta);
    },

    async uploadFile(stream, name, mimeType) {
      if (failing) throw offline();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return meta(addFile(name, mimeType, Buffer.concat(chunks), uploadDims));
    },

    async downloadStream(fileId, range) {
      downloads++;
      const file = files.get(fileId);
      if (!file) throw Object.assign(new Error('not found'), { status: 404 });
      const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        return { status: 200, headers: { 'content-length': String(file.size) }, stream: Readable.from([file.data]) };
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : file.size - 1;
      if (start >= file.size) throw Object.assign(new Error('range'), { status: 416 });
      return {
        status: 206,
        headers: { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${file.size}` },
        stream: Readable.from([file.data.subarray(start, end + 1)]),
      };
    },

    async deleteFile(fileId) {
      if (!files.delete(fileId)) throw Object.assign(new Error('not found'), { status: 404 });
    },

    // Test helpers
    addFile,
    removeFile: (id) => files.delete(id),
    replaceContent(id, data) {
      const file = files.get(id);
      file.data = data;
      file.size = data.length;
      file.md5Checksum = crypto.createHash('md5').update(data).digest('hex');
    },
    setDims(id, width, height) {
      Object.assign(files.get(id), { width, height });
    },
    setUploadDims: (dims) => (uploadDims = dims),
    has: (id) => files.has(id),
    findByName: (name) => [...files.values()].find((f) => f.name === name),
    setFailing: (value) => (failing = value),
    downloadCount: () => downloads,
  };
}

module.exports = { createFakeGoogle };
