import { OrbitDBStorachaBridge } from 'orbitdb-storacha-bridge';

export function parseBackupFiles(spaceFiles) {
	const backups = [];
	const metadataFiles = [];
	const blockFiles = [];

	for (const file of spaceFiles) {
		const cid = file.root;
		blockFiles.push(file);
	}

	const backupGroups = new Map();
	
	for (const file of blockFiles) {
		const timestamp = file.insertedAt || file.uploaded.toISOString();
		const dateKey = new Date(timestamp).toISOString().split('T')[0]; // Group by date
		
		if (!backupGroups.has(dateKey)) {
			backupGroups.set(dateKey, []);
		}
		backupGroups.get(dateKey).push(file);
	}

	for (const [dateKey, files] of backupGroups) {
		const sortedFiles = files.sort((a, b) => 
			new Date(a.insertedAt || a.uploaded) - new Date(b.insertedAt || b.uploaded)
		);
		
		const firstFile = sortedFiles[0];
		const lastFile = sortedFiles[sortedFiles.length - 1];
		
		backups.push({
			id: dateKey,
			timestamp: new Date(firstFile.insertedAt || firstFile.uploaded),
			blockCount: files.length,
			totalSize: files.reduce((sum, f) => sum + (typeof f.size === 'number' ? f.size : 0), 0),
			files: files,
			firstUpload: new Date(firstFile.insertedAt || firstFile.uploaded),
			lastUpload: new Date(lastFile.insertedAt || lastFile.uploaded),
		});
	}

	backups.sort((a, b) => b.timestamp - a.timestamp);

	return { backups, metadataFiles, blockFiles };
}

export async function listBackups(bridge) {
	const spaceFiles = await bridge.listSpaceFiles();
	const { backups } = parseBackupFiles(spaceFiles);
	return backups;
}
export async function getLatestBackup(bridge) {
	const backups = await listBackups(bridge);
	return backups.length > 0 ? backups[0] : null;
}


export async function getBackupByTimestamp(bridge, timestamp) {
	const backups = await listBackups(bridge);
	const targetDate = new Date(timestamp);
	const targetDateKey = targetDate.toISOString().split('T')[0];
	
	return backups.find(b => b.id === targetDateKey) || null;
}
export function formatBackupSize(bytes) {
	if (typeof bytes !== 'number' || bytes === 0) return '0 B';
	
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const k = 1024;
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	
	return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}
export function formatRelativeTime(date) {
	if (!date) return 'Never';
	
	const now = new Date();
	const then = new Date(date);
	const diffInSeconds = Math.floor((now - then) / 1000);
	
	if (diffInSeconds < 60) return 'Just now';
	if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
	if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
	if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)} days ago`;
	if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)} months ago`;
	return `${Math.floor(diffInSeconds / 31536000)} years ago`;
}

export function formatDateTime(date) {
	if (!date) return 'Unknown';
	return new Date(date).toLocaleString();
}


export async function createBackup(bridge, orbitdb, databaseAddress, options = {}) {
	const backupOptions = {
		...options,
		timestamp: new Date().toISOString(),
	};
	
	const result = options.logEntriesOnly
		? await bridge.backupLogEntriesOnly(orbitdb, databaseAddress, backupOptions)
		: await bridge.backup(orbitdb, databaseAddress, backupOptions);
	
	if (result.success) {
		result.metadata = {
			timestamp: backupOptions.timestamp,
			description: options.description || 'Database backup',
			databaseAddress,
			backupType: options.logEntriesOnly ? 'log-entries-only' : 'full',
		};
	}
	
	return result;
}

export async function restoreFromBackup(bridge, orbitdb, backup, options = {}) {
	return await bridge.restoreLogEntriesOnly(orbitdb, {
		...options,
		backupTimestamp: backup.timestamp,
	});
}
export async function getSpaceUsage(bridge) {
	const spaceFiles = await bridge.listSpaceFiles();
	const { backups } = parseBackupFiles(spaceFiles);
	
	const totalSize = spaceFiles.reduce((sum, f) => 
		sum + (typeof f.size === 'number' ? f.size : 0), 0
	);
	
	const latestUpload = spaceFiles.length > 0
		? spaceFiles.reduce((latest, f) => {
			const fileDate = new Date(f.insertedAt || f.uploaded);
			return fileDate > latest ? fileDate : latest;
		}, new Date(0))
		: null;
	
	return {
		totalFiles: spaceFiles.length,
		totalSize,
		totalSizeFormatted: formatBackupSize(totalSize),
		backupCount: backups.length,
		latestUpload,
		latestUploadFormatted: latestUpload ? formatRelativeTime(latestUpload) : 'Never',
	};
}
