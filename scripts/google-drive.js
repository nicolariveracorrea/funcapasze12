const crypto = require('crypto');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function readGoogleDriveConfig() {
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '');
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.');
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('The Google service-account JSON is missing client_email or private_key.');
  }
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
  if (!folderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is required.');

  const encryptionKey = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || '', 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return { credentials, folderId, encryptionKey };
}

async function getAccessToken(credentials) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsignedToken = [
    base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64Url(JSON.stringify({
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/drive.file',
      aud: 'https://oauth2.googleapis.com/token',
      iat: issuedAt,
      exp: issuedAt + 3600
    }))
  ].join('.');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsignedToken), credentials.private_key).toString('base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsignedToken}.${signature}`
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) {
    throw new Error(`Google OAuth failed (${response.status}): ${result.error_description || result.error || 'no access token returned'}`);
  }
  return result.access_token;
}

async function uploadFile(filePath, name, folderId, accessToken) {
  const size = fs.statSync(filePath).size;
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(size)
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/octet-stream',
      parents: [folderId]
    })
  });
  if (!start.ok) {
    const errorBody = await start.text();
    throw new Error(`Google Drive upload session failed (${start.status}): ${errorBody.slice(0, 400)}`);
  }
  const uploadUrl = start.headers.get('location');
  if (!uploadUrl) throw new Error('Google Drive did not return a resumable upload URL.');

  const uploaded = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: Readable.toWeb(fs.createReadStream(filePath)),
    duplex: 'half'
  });
  const result = await uploaded.json().catch(() => ({}));
  if (!uploaded.ok || !result.id) {
    throw new Error(`Google Drive upload failed (${uploaded.status}): ${result.error?.message || 'no file ID returned'}`);
  }
  return result.id;
}

async function downloadFile(fileId, destinationPath, accessToken) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('alt', 'media');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok || !response.body) {
    const message = await response.text().catch(() => '');
    throw new Error(`Google Drive download failed (${response.status}): ${message.slice(0, 400)}`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 })
  );
}

async function listBackupFiles(folderId, accessToken) {
  const params = new URLSearchParams({
    q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
    orderBy: 'createdTime desc',
    pageSize: '100',
    fields: 'files(id, name, createdTime)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google Drive listing failed (${response.status}): ${result.error?.message || 'unknown error'}`);
  }
  return result.files || [];
}

async function deleteFile(fileId, accessToken) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok && response.status !== 404) {
    const message = await response.text().catch(() => '');
    throw new Error(`Google Drive delete failed (${response.status}): ${message.slice(0, 400)}`);
  }
}

module.exports = { readGoogleDriveConfig, getAccessToken, uploadFile, downloadFile, listBackupFiles, deleteFile };
