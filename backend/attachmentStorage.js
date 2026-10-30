'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');
const { DefaultAzureCredential } = require('@azure/identity');
const {
  BlobServiceClient,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
} = require('@azure/storage-blob');

const IMAGE_TYPES = Object.freeze({
  '.jpg': { contentType: 'image/jpeg', category: 'image' },
  '.jpeg': { contentType: 'image/jpeg', category: 'image' },
  '.png': { contentType: 'image/png', category: 'image' },
  '.gif': { contentType: 'image/gif', category: 'image' },
  '.webp': { contentType: 'image/webp', category: 'image' },
});
const VIDEO_TYPES = Object.freeze({
  '.mp4': { contentType: 'video/mp4', category: 'video' },
  '.webm': { contentType: 'video/webm', category: 'video' },
});
const DOCUMENT_TYPES = Object.freeze({
  '.pdf': { contentType: 'application/pdf', category: 'document' },
  '.txt': { contentType: 'text/plain; charset=utf-8', category: 'document' },
  '.csv': { contentType: 'text/csv; charset=utf-8', category: 'document' },
  '.docx': { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', category: 'document' },
  '.xlsx': { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', category: 'document' },
  '.pptx': { contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', category: 'document' },
});
const ALLOWED_TYPES = Object.freeze({ ...IMAGE_TYPES, ...VIDEO_TYPES, ...DOCUMENT_TYPES });
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const UPLOAD_TICKET_TTL_MS = 30 * 60 * 1000;
const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const BLOCK_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENCY = 2;
const MALWARE_SCAN_RESULT_TAG = 'Malware Scanning scan result';
const MALWARE_SCAN_CLEAN_RESULT = 'No threats found';
const DEFAULT_MALWARE_SCAN_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_MALWARE_SCAN_POLL_INTERVAL_MS = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class AttachmentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AttachmentError';
    this.statusCode = statusCode;
  }
}

function normalizeFileName(value) {
  if (typeof value !== 'string') {
    throw new AttachmentError('Tên tệp không hợp lệ.');
  }
  const fileName = value.split(/[\\/]/u).pop().replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  if (!fileName || fileName.length > 120 || fileName === '.' || fileName === '..') {
    throw new AttachmentError('Tên tệp phải có từ 1 đến 120 ký tự.');
  }
  return fileName;
}

function getFilePolicy(fileName, size) {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  const type = ALLOWED_TYPES[extension];
  if (!type) {
    throw new AttachmentError('Định dạng chưa được hỗ trợ. Hãy chọn ảnh, video MP4/WebM hoặc tài liệu PDF, DOCX, XLSX, PPTX, TXT, CSV.');
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new AttachmentError('Kích thước tệp không hợp lệ.');
  }

  const maxBytes = type.category === 'video' ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
  if (size > maxBytes) {
    const limitMb = maxBytes / 1024 / 1024;
    throw new AttachmentError(`Tệp vượt giới hạn ${limitMb} MB.`);
  }

  return { ...type, extension, maxBytes };
}

function hasExpectedSignature(contentType, header) {
  if (contentType === 'image/png') {
    return header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (contentType === 'image/jpeg') return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (contentType === 'image/gif') return header.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/u) !== null;
  if (contentType === 'image/webp') {
    return header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
  }
  if (contentType === 'video/mp4') return header.length >= 8 && header.toString('ascii', 4, 8) === 'ftyp';
  if (contentType === 'video/webm') return header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (contentType === 'application/pdf') return header.subarray(0, 5).toString('ascii') === '%PDF-';
  if (contentType.startsWith('text/')) return !header.includes(0);
  if (contentType.startsWith('application/vnd.openxmlformats-officedocument.')) {
    return header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }
  return false;
}

function encodeFileName(fileName) {
  return encodeURIComponent(fileName).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function createAttachmentStorage({
  accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME,
  containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'chat-attachments',
  endpoint = process.env.AZURE_STORAGE_BLOB_ENDPOINT,
  tokenSecret = process.env.ATTACHMENT_TOKEN_SECRET,
  malwareScanTimeoutMs = process.env.ATTACHMENT_SCAN_TIMEOUT_MS,
  malwareScanPollIntervalMs = DEFAULT_MALWARE_SCAN_POLL_INTERVAL_MS,
  credential,
  blobServiceClient,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const enabled = Boolean(accountName);
  if (enabled && (!tokenSecret || Buffer.byteLength(tokenSecret, 'utf8') < 32)) {
    throw new Error('ATTACHMENT_TOKEN_SECRET must contain at least 32 bytes when Azure attachments are enabled.');
  }
  const parsedScanTimeoutMs = Number(malwareScanTimeoutMs);
  const scanTimeoutMs = Number.isSafeInteger(parsedScanTimeoutMs) && parsedScanTimeoutMs > 0
    ? parsedScanTimeoutMs
    : DEFAULT_MALWARE_SCAN_TIMEOUT_MS;
  const parsedScanPollIntervalMs = Number(malwareScanPollIntervalMs);
  const scanPollIntervalMs = Number.isSafeInteger(parsedScanPollIntervalMs) && parsedScanPollIntervalMs > 0
    ? parsedScanPollIntervalMs
    : DEFAULT_MALWARE_SCAN_POLL_INTERVAL_MS;

  const serviceClient = enabled
    ? blobServiceClient || new BlobServiceClient(
      endpoint || `https://${accountName}.blob.core.windows.net`,
      credential || new DefaultAzureCredential(),
    )
    : null;
  const containerClient = serviceClient ? serviceClient.getContainerClient(containerName) : null;
  const secret = tokenSecret ? Buffer.from(tokenSecret, 'utf8') : null;

  async function waitForCleanMalwareScan(blob) {
    const deadline = now() + scanTimeoutMs;
    while (true) {
      const response = await blob.getTags();
      if (!Array.isArray(response.blobTagSet)) {
        throw new AttachmentError('Azure Defender trả về trạng thái quét không hợp lệ; tệp không được chia sẻ.', 503);
      }
      const resultTag = response.blobTagSet.find((tag) => tag.key === MALWARE_SCAN_RESULT_TAG);
      const result = resultTag && resultTag.value;

      if (result === MALWARE_SCAN_CLEAN_RESULT) return;
      if (result === 'Malicious') {
        throw new AttachmentError('Azure Defender phát hiện mã độc; tệp không được chia sẻ.', 422);
      }
      if (result === 'Error' || result === 'Not scanned') {
        throw new AttachmentError('Không thể xác nhận tệp đã sạch; tệp không được chia sẻ.', 503);
      }
      if (result) {
        throw new AttachmentError('Azure Defender trả về trạng thái quét chưa được hỗ trợ; tệp không được chia sẻ.', 503);
      }

      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw new AttachmentError('Quét mã độc chưa hoàn tất; tệp không được chia sẻ. Vui lòng thử lại sau.', 503);
      }
      await sleep(Math.min(scanPollIntervalMs, remainingMs));
    }
  }

  function signClaims(claims) {
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  function verifyTicket(ticket, expectedUploadId) {
    if (!secret || typeof ticket !== 'string' || ticket.length > 4096) {
      throw new AttachmentError('Mã tải tệp không hợp lệ hoặc đã hết hạn.', 401);
    }

    const [encoded, suppliedSignature, extra] = ticket.split('.');
    if (!encoded || !suppliedSignature || extra !== undefined) {
      throw new AttachmentError('Mã tải tệp không hợp lệ.', 401);
    }
    const expectedSignature = crypto.createHmac('sha256', secret).update(encoded).digest();
    let receivedSignature;
    try {
      receivedSignature = Buffer.from(suppliedSignature, 'base64url');
    } catch {
      throw new AttachmentError('Mã tải tệp không hợp lệ.', 401);
    }
    if (receivedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(receivedSignature, expectedSignature)) {
      throw new AttachmentError('Mã tải tệp không hợp lệ.', 401);
    }

    let claims;
    try {
      claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new AttachmentError('Mã tải tệp không hợp lệ.', 401);
    }
    if (
      (expectedUploadId && claims.uploadId !== expectedUploadId)
      || !UUID_PATTERN.test(claims.uploadId)
      || claims.expiresAt <= now()
      || typeof claims.clientId !== 'string'
      || typeof claims.partnerId !== 'string'
      || typeof claims.blobName !== 'string'
    ) {
      throw new AttachmentError('Mã tải tệp đã hết hạn hoặc không đúng phiên.', 401);
    }
    return claims;
  }

  function issueUploadTicket(clientId, partnerId, fileName, size) {
    if (!enabled) throw new AttachmentError('Tính năng gửi tệp chưa được cấu hình.', 503);
    const normalizedName = normalizeFileName(fileName);
    const policy = getFilePolicy(normalizedName, size);
    const uploadId = crypto.randomUUID();
    const claims = {
      uploadId,
      clientId,
      partnerId,
      fileName: normalizedName,
      contentType: policy.contentType,
      category: policy.category,
      size,
      blobName: `chat/${uploadId}`,
      expiresAt: now() + UPLOAD_TICKET_TTL_MS,
    };
    return {
      uploadId,
      ticket: signClaims(claims),
      uploadPath: `/api/attachments/${uploadId}`,
      fileName: normalizedName,
      contentType: policy.contentType,
      category: policy.category,
      size,
      expiresAt: claims.expiresAt,
    };
  }

  async function upload(uploadId, ticket, request) {
    if (!enabled) throw new AttachmentError('Tính năng gửi tệp chưa được cấu hình.', 503);
    const claims = verifyTicket(ticket, uploadId);
    const contentLength = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(contentLength) || contentLength !== claims.size) {
      request.resume();
      throw new AttachmentError('Kích thước tải lên không khớp với yêu cầu.');
    }
    const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== claims.contentType.split(';')[0]) {
      request.resume();
      throw new AttachmentError('Loại nội dung tải lên không khớp.');
    }

    const iterator = request[Symbol.asyncIterator]();
    const prefixChunks = [];
    let prefixSize = 0;
    let streamEnded = false;
    while (prefixSize < 16 && !streamEnded) {
      const next = await iterator.next();
      streamEnded = next.done;
      if (!next.done) {
        const chunk = Buffer.from(next.value);
        prefixChunks.push(chunk);
        prefixSize += chunk.length;
      }
    }
    if (prefixSize === 0) throw new AttachmentError('Tệp tải lên đang trống.');
    const prefix = Buffer.concat(prefixChunks);
    if (!hasExpectedSignature(claims.contentType.split(';')[0], prefix.subarray(0, 16))) {
      request.resume();
      throw new AttachmentError('Nội dung tệp không khớp với định dạng được chọn.');
    }

    let byteCount = 0;
    async function* checkedBody() {
      for (const chunk of prefixChunks) {
        byteCount += chunk.length;
        if (byteCount > claims.size) throw new AttachmentError('Tệp vượt quá kích thước đã khai báo.');
        yield chunk;
      }
      while (!streamEnded) {
        const next = await iterator.next();
        streamEnded = next.done;
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        byteCount += chunk.length;
        if (byteCount > claims.size) throw new AttachmentError('Tệp vượt quá kích thước đã khai báo.');
        yield chunk;
      }
      if (byteCount !== claims.size) throw new AttachmentError('Kích thước tệp tải lên không chính xác.');
    }

    const blob = containerClient.getBlockBlobClient(claims.blobName);
    const disposition = claims.category === 'image' || claims.category === 'video' ? 'inline' : 'attachment';
    await blob.uploadStream(Readable.from(checkedBody()), BLOCK_SIZE_BYTES, MAX_CONCURRENCY, {
      blobHTTPHeaders: {
        blobContentType: claims.contentType,
        blobContentDisposition: `${disposition}; filename*=UTF-8''${encodeFileName(claims.fileName)}`,
        blobCacheControl: 'private, no-store',
      },
      conditions: { ifNoneMatch: '*' },
    });

    return { uploadId: claims.uploadId, size: claims.size };
  }

  async function completeUpload(clientId, ticket) {
    if (!enabled) throw new AttachmentError('Tính năng gửi tệp chưa được cấu hình.', 503);
    const claims = verifyTicket(ticket);
    if (claims.clientId !== clientId) {
      throw new AttachmentError('Tệp này không thuộc phiên hiện tại.', 403);
    }

    const blob = containerClient.getBlockBlobClient(claims.blobName);
    let properties;
    try {
      properties = await blob.getProperties();
    } catch (error) {
      if (error.statusCode === 404) {
        throw new AttachmentError('Tệp chưa tải lên hoàn tất.', 409);
      }
      throw error;
    }
    if (properties.contentLength !== claims.size || properties.contentType !== claims.contentType) {
      throw new AttachmentError('Thông tin tệp lưu trữ không khớp.', 400);
    }

    await waitForCleanMalwareScan(blob);

    const startsOn = new Date(now() - 5 * 60 * 1000);
    const expiresOn = new Date(now() + DOWNLOAD_TTL_MS);
    const delegationKey = await serviceClient.getUserDelegationKey(startsOn, expiresOn);
    const sas = generateBlobSASQueryParameters({
      containerName,
      blobName: claims.blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https,
    }, delegationKey, accountName).toString();
    const blobUrl = new URL(blob.url);
    blobUrl.search = sas;

    return {
      fileName: claims.fileName,
      contentType: claims.contentType,
      category: claims.category,
      size: claims.size,
      url: blobUrl.toString(),
      expiresAt: expiresOn.toISOString(),
    };
  }

  return {
    enabled,
    issueUploadTicket,
    validateTicket: verifyTicket,
    upload,
    completeUpload,
  };
}

module.exports = {
  AttachmentError,
  MAX_FILE_BYTES,
  MAX_VIDEO_BYTES,
  createAttachmentStorage,
  getFilePolicy,
  hasExpectedSignature,
  normalizeFileName,
};
