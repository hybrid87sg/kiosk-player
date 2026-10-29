// Everything that talks to Google lives here, behind five small functions.
// app.js only calls these, so the tests can swap in a fake (test/fake-google.js)
// and run without a real Google account.
//
//   verifyIdToken(idToken)          -> { email }   checks a "Sign in with Google" token
//   listFolder()                    -> [file]      files in the signage Drive folder
//   uploadFile(stream, name, mime)  -> file        saves a new file into the folder
//   downloadStream(fileId, range)   -> { status, headers, stream }
//   deleteFile(fileId)                             moves a file to Drive's trash
//
// A "file" is { id, name, mimeType, size, md5Checksum, width, height }.
// width/height are null while Drive is still processing a new video.

const fs = require('node:fs');
const { Readable } = require('node:stream');
const { drive: makeDrive, auth: googleAuth } = require('@googleapis/drive');
const { OAuth2Client } = require('google-auth-library');

const FILE_FIELDS = 'id, name, mimeType, size, md5Checksum, imageMediaMetadata(width, height, rotation), videoMediaMetadata(width, height)';

function createGoogle({ webClientId, serviceAccountFile, folderId }) {
  // The server acts as the "service account" (a robot Google user) that has
  // been added to the Shared Drive. supportsAllDrives is needed for Shared Drives.
  const key = JSON.parse(fs.readFileSync(serviceAccountFile, 'utf8'));
  const drive = makeDrive({
    version: 'v3',
    auth: new googleAuth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/drive'],
    }),
  });
  const signInChecker = new OAuth2Client();

  async function verifyIdToken(idToken) {
    // Checks Google's signature, expiry, and that the token was made for OUR app.
    const ticket = await signInChecker.verifyIdToken({ idToken, audience: webClientId });
    const payload = ticket.getPayload();
    if (!payload.email || !payload.email_verified) throw new Error('Google account has no verified email');
    return { email: payload.email };
  }

  async function listFolder() {
    const files = [];
    let pageToken;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
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
      requestBody: { name, parents: [folderId] },
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

  return { verifyIdToken, listFolder, uploadFile, downloadStream, deleteFile };
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

module.exports = { createGoogle };
