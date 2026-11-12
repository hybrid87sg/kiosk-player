// Everything that talks to Google Drive lives here, behind a few small functions.
// app.js only calls these, so the tests can swap in a fake (test/fake-google.js)
// and run without a real Google account. (Signing in no longer involves Google.)
//
//   listFolder()                    -> [file]      files in the signage Drive folder
//   uploadFile(stream, name, mime)  -> file        saves a new file into the folder
//   downloadStream(fileId, range)   -> { status, headers, stream }
//   deleteFile(fileId)                             moves a file to Drive's trash (only used to clean up a failed upload; Kiosk never deletes library files from Drive)
//   getFolderId() / setFolderId(id)                which Drive folder is used
//   keyEmail() / setServiceAccountKey(key)         the service account in use; the key can be added later
//
// A "file" is { id, name, mimeType, size, md5Checksum, width, height }.
// width/height are null while Drive is still processing a new video.

const fs = require('node:fs');
const { Readable } = require('node:stream');
const { drive: makeDrive, auth: googleAuth } = require('@googleapis/drive');

const FILE_FIELDS = 'id, name, mimeType, size, md5Checksum, imageMediaMetadata(width, height, rotation), videoMediaMetadata(width, height)';

/**
 * Checks the text of a service account key file. Returns { client_email, private_key },
 * or throws with a message a person can act on.
 */
function parseServiceAccountKey(text) {
  let key;
  try {
    key = JSON.parse(String(text || ''));
  } catch {
    throw new Error('That isn\'t a key file: it should be the whole .json file Google gave you, starting with { and ending with }.');
  }
  if (!key || typeof key !== 'object' || key.type !== 'service_account') {
    throw new Error('That file isn\'t a service account key. Use the .json file from the service account\'s Keys tab.');
  }
  if (typeof key.client_email !== 'string' || !key.client_email.includes('@')
    || typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) {
    throw new Error('That key file is missing its client_email or private_key. Download a new key and try again.');
  }
  return { client_email: key.client_email, private_key: key.private_key };
}

/**
 * Turns a failed Drive call into one sentence that says what to do.
 * `email` is the service account's address, when known.
 */
function explainDriveError(err, email) {
  const robot = email || 'the service account\'s email (client_email in the key file)';
  if (err && err.code === 'NO_GOOGLE_KEY') return 'The Google key hasn\'t been added yet. Add it under Settings → Google key.';
  const status = Number(err && (err.status || err.code)) || 0;
  const text = `${(err && err.message) || ''} ${JSON.stringify((err && err.errors) || (err && err.cause && err.cause.errors) || '')}`;
  if (/storageQuota|storage quota/i.test(text)) {
    return 'Google refused the upload: the service account has no storage of its own. Use a shared drive, or add files through Google Drive instead.';
  }
  if (/accessNotConfigured|has not been used in project|is disabled/i.test(text)) {
    return 'The Google Drive API is switched off for your Google Cloud project. Enable "Google Drive API" under APIs & Services → Library.';
  }
  if (/invalid_grant|invalid_client|Invalid JWT|DECODER|PEM/i.test(text)) {
    return 'Google didn\'t accept the key. It may have been deleted or replaced. Add the current key under Settings → Google key.';
  }
  if (status === 404) return `Google can't find the Drive folder. Check the folder ID, and share the folder with ${robot} as Editor (Content manager on a shared drive).`;
  if (status === 403) return `Google says the server isn't allowed to do that. Share the Drive folder with ${robot} as Editor (Content manager on a shared drive).`;
  return 'Could not reach Google Drive. Check the internet connection and try again.';
}

function createGoogle({ serviceAccountFile, serviceAccountKey = null, folderId }) {
  let currentFolderId = folderId;
  // The server acts as the "service account" (a robot Google user) that has
  // been given the Drive folder. supportsAllDrives is needed for Shared Drives.
  // The key can arrive later (added on the Settings page), so the Drive client
  // is built when a key is set, and calls before that fail with NO_GOOGLE_KEY.
  let client = null;
  let keyEmail = null;
  function setServiceAccountKey(key) {
    client = makeDrive({
      version: 'v3',
      auth: new googleAuth.JWT({
        email: key.client_email,
        key: key.private_key,
        scopes: ['https://www.googleapis.com/auth/drive'],
      }),
    });
    keyEmail = key.client_email;
  }
  const drive = {
    get files() {
      if (!client) throw Object.assign(new Error('No Google key yet'), { code: 'NO_GOOGLE_KEY' });
      return client.files;
    },
  };
  if (serviceAccountKey) setServiceAccountKey(serviceAccountKey);
  else if (serviceAccountFile) setServiceAccountKey(parseServiceAccountKey(fs.readFileSync(serviceAccountFile, 'utf8')));
  async function listFolder() {
    const files = [];
    let pageToken;
    do {
      const res = await drive.files.list({
        q: `'${currentFolderId}' in parents and trashed = false`,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      files.push(...res.data.files);
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return files.map(normalise);
  }

  async function uploadFile(stream, name, mimeType) {
    const res = await drive.files.create({
      requestBody: { name, parents: [currentFolderId] },
      media: { mimeType, body: stream },
      fields: FILE_FIELDS,
      supportsAllDrives: true,
    });
    return normalise(res.data);
  }

  async function downloadStream(fileId, range) {
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream', headers: range ? { Range: range } : {} }
    );
    const pick = (name) => res.headers.get(name) || undefined;
    return {
      status: res.status,
      headers: { 'content-length': pick('content-length'), 'content-range': pick('content-range') },
      stream: typeof res.data.pipe === 'function' ? res.data : Readable.fromWeb(res.data),
    };
  }

  async function deleteFile(fileId) {
    await drive.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true });
  }

  return {
    listFolder,
    uploadFile,
    downloadStream,
    deleteFile,
    getFolderId: () => currentFolderId,
    setFolderId: (id) => { currentFolderId = id; },
    setServiceAccountKey,
    keyEmail: () => keyEmail,
  };
}

// Drive sends size as a string and keeps width/height in separate image and
// video sections; flatten that into plain numbers. A picture stored sideways
// (rotation 90 or 270) has its width and height swapped.
function normalise(file) {
  const image = file.imageMediaMetadata;
  const video = file.videoMediaMetadata;
  let width = null;
  let height = null;
  if (image && image.width && image.height) {
    const sideways = image.rotation === 1 || image.rotation === 3 || image.rotation === 90 || image.rotation === 270;
    width = sideways ? image.height : image.width;
    height = sideways ? image.width : image.height;
  } else if (video && video.width && video.height) {
    width = video.width;
    height = video.height;
  }
  return { id: file.id, name: file.name, mimeType: file.mimeType, size: Number(file.size), md5Checksum: file.md5Checksum, width, height };
}

module.exports = { createGoogle, parseServiceAccountKey, explainDriveError };
