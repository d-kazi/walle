import fs from 'node:fs';
import { google } from 'googleapis';
import type { GoogleAuths } from './auth.js';
import type { DriveFile, DriveService } from './types.js';

const BACKUP_FOLDER_NAME = '_walle-backup';

/**
 * Drive access via Dan's principal: read-only listing/fetch of the one
 * family folder, plus writes to its _walle-backup subfolder only.
 */
export class GoogleDriveService implements DriveService {
  private backupFolderId: string | null = null;

  constructor(
    private readonly auths: GoogleAuths,
    private readonly familyFolderId: string,
  ) {}

  private drive() {
    return google.drive({ version: 'v3', auth: this.auths.clientFor('dan') });
  }

  async listFamilyFolder(): Promise<DriveFile[]> {
    const res = await this.drive().files.list({
      q: `'${this.familyFolderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime)',
      pageSize: 100,
    });
    return (res.data.files ?? []).map((f) => ({
      id: f.id ?? '',
      name: f.name ?? '',
      mimeType: f.mimeType ?? '',
      modified: f.modifiedTime ?? '',
    }));
  }

  async fetchFileText(fileId: string): Promise<string> {
    const drive = this.drive();
    const meta = await drive.files.get({ fileId, fields: 'mimeType, name' });
    const mime = meta.data.mimeType ?? '';
    if (mime.startsWith('application/vnd.google-apps')) {
      const res = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
      return String(res.data).slice(0, 30000);
    }
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
    return String(res.data).slice(0, 30000);
  }

  private async ensureBackupFolder(): Promise<string> {
    if (this.backupFolderId) return this.backupFolderId;
    const drive = this.drive();
    const existing = await drive.files.list({
      q: `'${this.familyFolderId}' in parents and name = '${BACKUP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
    });
    let id = existing.data.files?.[0]?.id ?? null;
    if (!id) {
      const created = await drive.files.create({
        requestBody: {
          name: BACKUP_FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [this.familyFolderId],
        },
        fields: 'id',
      });
      id = created.data.id ?? null;
    }
    if (!id) throw new Error('Could not resolve _walle-backup folder');
    this.backupFolderId = id;
    return id;
  }

  async uploadBackup(name: string, localPath: string): Promise<void> {
    const folderId = await this.ensureBackupFolder();
    await this.drive().files.create({
      requestBody: { name, parents: [folderId] },
      media: { mimeType: 'application/gzip', body: fs.createReadStream(localPath) },
      fields: 'id',
    });
  }

  async listBackups(): Promise<DriveFile[]> {
    const folderId = await this.ensureBackupFolder();
    const res = await this.drive().files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime)',
      pageSize: 100,
    });
    return (res.data.files ?? []).map((f) => ({
      id: f.id ?? '',
      name: f.name ?? '',
      mimeType: f.mimeType ?? '',
      modified: f.modifiedTime ?? '',
    }));
  }

  async deleteBackup(fileId: string): Promise<void> {
    await this.drive().files.delete({ fileId });
  }
}
