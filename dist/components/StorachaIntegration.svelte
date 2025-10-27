<script>
	import { onMount } from 'svelte';
	import {
		Cloud,
		Upload,
		Plus,
		List,
		Key,
		Mail,
		LogOut,
		Loader2,
		AlertCircle,
		CheckCircle,
		Download
	} from 'lucide-svelte';
	import {
		initializeStorachaClient,
		createStorachaAccount,
		listSpaces,
		createSpace
	} from './storacha-backup.js';
	import { OrbitDBStorachaBridge, restoreDatabaseFromSpace } from 'orbitdb-storacha-bridge';
	import { todosStore } from './db-actions.js';
	import { initializationStore, orbitDBStore, libp2pStore, peerIdStore } from './p2p.js';
	import { initializeDatabase, loadTodos, todoDBStore } from './db-actions.js';
	// Add imports for creating fresh instances
	import { createLibp2p } from 'libp2p';
	import { createHelia } from 'helia';
	import { createOrbitDB } from '@orbitdb/core';
	import { createLibp2pConfig } from './libp2p-config.js';
	import { LevelBlockstore } from 'blockstore-level';
	import { LevelDatastore } from 'datastore-level';

	// Component state
	let showStoracha = false;
	let isLoading = false;
	let status = '';
	let error = null;
	let success = null;

	// Auth state
	let isLoggedIn = false;
	let client = null;
	let currentSpace = null;

	// Progress tracking state
	let showProgress = false;
	let progressType = ''; // 'upload' or 'download'
	let progressCurrent = 0;
	let progressTotal = 0;
	let progressPercentage = 0;
	let progressCurrentBlock = null;
	let progressError = null;

	// Bridge instance
	let bridge = null;

	// LocalStorage keys
	const STORAGE_KEYS = {
		STORACHA_KEY: 'storacha_key',
		STORACHA_PROOF: 'storacha_proof',
		AUTO_LOGIN: 'storacha_auto_login'
	};

	// Form state
	let showCreateForm = false;
	let showCredentialsForm = false;
	let email = '';
	let storachaKey = '';
	let storachaProof = '';
	let newSpaceName = '';

	// Data state
	let spaces = [];



	// Progress tracking functions
	function initializeBridge(storachaKey, storachaProof) {
		if (bridge) {
			// Remove existing listeners
			bridge.removeAllListeners();
		}

		bridge = new OrbitDBStorachaBridge({
			storachaKey,
			storachaProof
		});

		// Set up progress event listeners
		bridge.on('uploadProgress', (progress) => {
			console.log(
				`Upload Progress: ${progress.current}/${progress.total} (${progress.percentage}%)`
			);

			progressType = 'upload';
			progressCurrent = progress.current;
			progressTotal = progress.total;
			progressPercentage = progress.percentage;
			progressCurrentBlock = progress.currentBlock;
			progressError = progress.error;
			showProgress = true;

			// Update status text
			if (progress.error) {
				status = `Upload error: ${progress.error.message}`;
			} else if (progress.currentBlock) {
				status = `Uploading block ${progress.current} of ${progress.total} (${progress.currentBlock.hash.slice(0, 8)}...)`;
			} else {
				status = `Uploading block ${progress.current} of ${progress.total}`;
			}
		});

		bridge.on('downloadProgress', (progress) => {
			console.log(
				`Download Progress: ${progress.current}/${progress.total} (${progress.percentage}%)`
			);

			progressType = 'download';
			progressCurrent = progress.current;
			progressTotal = progress.total;
			progressPercentage = progress.percentage;
			progressCurrentBlock = progress.currentBlock;
			progressError = progress.error;
			showProgress = true;

			// Update status text
			if (progress.error) {
				status = `Download error: ${progress.error.message}`;
			} else if (progress.currentBlock) {
				status = `Downloading block ${progress.current} of ${progress.total} (${progress.currentBlock.storachaCID.slice(0, 8)}...)`;
			} else {
				status = `Downloading block ${progress.current} of ${progress.total}`;
			}
		});

		return bridge;
	}

	function resetProgress() {
		showProgress = false;
		progressType = '';
		progressCurrent = 0;
		progressTotal = 0;
		progressPercentage = 0;
		progressCurrentBlock = null;
		progressError = null;
	}

	// LocalStorage functions
	function saveCredentials(key, proof) {
		try {
			console.log('💾 Saving credentials to localStorage...');
			localStorage.setItem(STORAGE_KEYS.STORACHA_KEY, key);
			localStorage.setItem(STORAGE_KEYS.STORACHA_PROOF, proof);
			localStorage.setItem(STORAGE_KEYS.AUTO_LOGIN, 'true');
			console.log('✅ Credentials saved successfully');
		} catch (err) {
			console.warn('❌ Failed to save credentials to localStorage:', err);
		}
	}

	function loadCredentials() {
		try {
			console.log('📖 Checking localStorage for credentials...');
			const key = localStorage.getItem(STORAGE_KEYS.STORACHA_KEY);
			const proof = localStorage.getItem(STORAGE_KEYS.STORACHA_PROOF);
			const autoLogin = localStorage.getItem(STORAGE_KEYS.AUTO_LOGIN);

			if (key && proof && autoLogin === 'true') {
				console.log('✅ Valid credentials found!');
				return { key, proof };
			} else {
				console.log('❌ No valid credentials found');
			}
		} catch (err) {
			console.warn('❌ Failed to load credentials from localStorage:', err);
		}
		return null;
	}

	function clearStoredCredentials() {
		try {
			localStorage.removeItem(STORAGE_KEYS.STORACHA_KEY);
			localStorage.removeItem(STORAGE_KEYS.STORACHA_PROOF);
			localStorage.removeItem(STORAGE_KEYS.AUTO_LOGIN);
		} catch (err) {
			console.warn('Failed to clear credentials from localStorage:', err);
		}
	}

	// Auto-hide messages
	function showMessage(message, type = 'info') {
		if (type === 'error') {
			error = message;
			success = null;
		} else {
			success = message;
			error = null;
		}

		setTimeout(() => {
			error = null;
			success = null;
		}, 5000);
	}

	// Clear forms
	function clearForms() {
		showCreateForm = false;
		showCredentialsForm = false;
		email = '';
		storachaKey = '';
		storachaProof = '';
		newSpaceName = '';
	}

	// Login with email
	async function handleEmailLogin() {
		if (!email.trim()) {
			showMessage('Please enter your email address', 'error');
			return;
		}

		isLoading = true;
		status = 'Creating account...';

		try {
			const result = await createStorachaAccount(email.trim());

			if (result.success) {
				showMessage(result.message);
				clearForms();
			} else {
				showMessage(result.error, 'error');
			}
		} catch (err) {
			showMessage(`Failed to create account: ${err.message}`, 'error');
		} finally {
			isLoading = false;
			status = '';
		}
	}

	// Login with credentials
	async function handleCredentialsLogin(useStoredCredentials = false) {
		console.log(
			'🚀 handleCredentialsLogin called with useStoredCredentials =',
			useStoredCredentials
		);

		let keyToUse = storachaKey.trim();
		let proofToUse = storachaProof.trim();

		console.log('🔍 Form values:', {
			hasKey: !!storachaKey.trim(),
			hasProof: !!storachaProof.trim(),
			keyLength: storachaKey.trim().length,
			proofLength: storachaProof.trim().length
		});

		// If using stored credentials, load them
		if (useStoredCredentials) {
			console.log('🔄 Loading stored credentials for auto-login...');
			const stored = loadCredentials();
			if (!stored) {
				console.log('⚠️ Auto-login failed: no stored credentials');
				showMessage('No stored credentials found', 'error');
				return;
			}
			keyToUse = stored.key;
			proofToUse = stored.proof;
			console.log('✅ Loaded stored credentials successfully');
		} else {
			console.log('🔐 Manual login with form credentials');
		}

		if (!keyToUse || !proofToUse) {
			showMessage('Please provide both Storacha key and proof', 'error');
			return;
		}

		isLoading = true;
		status = useStoredCredentials ? 'Auto-logging in...' : 'Logging in...';

		try {
			client = await initializeStorachaClient(keyToUse, proofToUse);

			// Initialize the bridge with credentials
			initializeBridge(keyToUse, proofToUse);

			// For credential-based login, check current space instead of accounts
			currentSpace = client.currentSpace();
			if (currentSpace) {
				// Credential-based login successful
				isLoggedIn = true;

				// Save credentials for future auto-login (only if not already stored)
				if (!useStoredCredentials) {
					saveCredentials(keyToUse, proofToUse);
					showMessage('Successfully logged in to Storacha! Credentials saved for auto-login.');
				} else {
					showMessage('Successfully auto-logged in to Storacha!');
				}

				clearForms();

				// Load spaces (will handle credential-based client properly)
				await loadSpaces();
			} else {
				// Try traditional account-based approach as fallback
				const accounts = client.accounts();
				if (accounts.length > 0) {
					isLoggedIn = true;

					if (!useStoredCredentials) {
						saveCredentials(keyToUse, proofToUse);
						showMessage('Successfully logged in to Storacha! Credentials saved for auto-login.');
					} else {
						showMessage('Successfully auto-logged in to Storacha!');
					}

					clearForms();
					await loadSpaces();
				} else {
					throw new Error('Failed to authenticate - no space or account found');
				}
			}
		} catch (err) {
			showMessage(`Login failed: ${err.message}`, 'error');
			// If auto-login failed, clear stored credentials
			if (useStoredCredentials) {
				clearStoredCredentials();
			}
		} finally {
			isLoading = false;
			status = '';
		}
	}

	// Logout
	function handleLogout() {
		isLoggedIn = false;
		client = null;
		currentSpace = null;
		spaces = [];
		clearForms();
		clearStoredCredentials(); // Clear stored credentials on logout

		// Clean up bridge
		if (bridge) {
			bridge.removeAllListeners();
			bridge = null;
		}

		resetProgress();
		showMessage('Logged out successfully');
	}

	// Load spaces
	async function loadSpaces() {
		if (!client) return;

		isLoading = true;
		status = 'Loading spaces...';

		try {
			spaces = await listSpaces(client);
		} catch (err) {
			showMessage(`Failed to load spaces: ${err.message}`, 'error');
		} finally {
			isLoading = false;
			status = '';
		}
	}

	// Create new space
	async function handleCreateSpace() {
		if (!newSpaceName.trim()) {
			showMessage('Please enter a space name', 'error');
			return;
		}

		isLoading = true;
		status = 'Creating space...';

		try {
			const result = await createSpace(client, newSpaceName.trim());

			if (result.success) {
				showMessage(`Space "${newSpaceName}" created successfully!`);
				newSpaceName = '';
				await loadSpaces(); // Reload spaces
			} else {
				showMessage(result.error, 'error');
			}
		} catch (err) {
			showMessage(`Failed to create space: ${err.message}`, 'error');
		} finally {
			isLoading = false;
			status = '';
		}
	}

	// Set current space
	async function selectSpace(space) {
		isLoading = true;
		status = 'Switching space...';

		try {
			await client.setCurrentSpace(space.did);
			currentSpace = space;
			showMessage(`Switched to space: ${space.name}`);
		} catch (err) {
			showMessage(`Failed to switch space: ${err.message}`, 'error');
		} finally {
			isLoading = false;
			status = '';
		}
	}

	// Backup database with progress tracking
	async function handleBackup() {
		if (!bridge) {
			showMessage('Please log in first', 'error');
			return;
		}

		if (!$initializationStore.isInitialized) {
			showMessage('OrbitDB is not initialized yet', 'error');
			return;
		}

		if ($todosStore.length === 0) {
			showMessage('No todos to backup', 'error');
			return;
		}

		isLoading = true;
		resetProgress();
		status = 'Preparing backup...';

		try {
			console.log('🚀 Starting backup with real progress tracking...', $todoDBStore);

			const result = await bridge.backup($orbitDBStore, $todoDBStore.address);

			if (result.success) {
				showMessage(
					`Backup completed! ${result.blocksUploaded}/${result.blocksTotal} blocks uploaded`
				);
			} else {
				showMessage(result.error, 'error');
			}
		} catch (err) {
			showMessage(`Backup failed: ${err.message}`, 'error');
		} finally {
			isLoading = false;
			status = '';
			resetProgress();
		}
	}



	// Format date
	function formatDate(dateString) {
		return new Date(dateString).toLocaleString();
	}

	// Format space name
	function formatSpaceName(space) {
		return space.name === 'Unnamed Space' ? `Space ${space.did.slice(-8)}` : space.name;
	}



	// Auto-login on component mount
	onMount(async () => {
		console.log('🚀 StorachaIntegration component mounted');

		// Try to auto-login with stored credentials (but don't show error for first-time users)
		const stored = loadCredentials();
		if (stored) {
			console.log('🔐 Found stored Storacha credentials, attempting auto-login...');
			try {
				await handleCredentialsLogin(true);
			} catch (err) {
				console.warn('⚠️ Auto-login failed, clearing stored credentials:', err);
				clearStoredCredentials();
			}
		} else {
			console.log('🔒 No stored credentials found, user needs to login manually');
		}
	});



	async function restoreFromSpace() {
		if (!$orbitDBStore) {
			showMessage('OrbitDB not initialized. Please wait for initialization to complete.', 'error');
			return;
		}

		isLoading = true;
		resetProgress();
		status = 'Preparing restore...';

		try {
			console.log('🔄 Starting restore from Storacha space with fresh OrbitDB instance...');

			// Get Storacha credentials
			const storachaKey = localStorage.getItem('storacha_key') || '';
			const storachaProof = localStorage.getItem('storacha_proof') || '';

			if (!storachaKey || !storachaProof) {
				throw new Error('Storacha credentials not found. Please login to Storacha first.');
			}

			// Step 1: Create fresh instances for restore
			status = 'Creating fresh OrbitDB instance for restore...';
			console.log('🔧 Creating fresh OrbitDB instance for restore...');

			// Create unique libp2p config
			const config = await createLibp2pConfig({
				enablePeerConnections: false,
				enableNetworkConnection: false,
				enablePersistentStorage: true
			});

			// Create fresh libp2p instance
			const newLibp2p = await createLibp2p(config);
			console.log('✅ Fresh libp2p instance created');

			// Create fresh Helia instance with persistent initializeDatabasestorage
			console.log('🗄️ Initializing fresh Helia with persistent storage...');
			const blockstore = new LevelBlockstore(`./helia-blocks-restore-${Date.now()}`);
			const datastore = new LevelDatastore(`./helia-data-restore-${Date.now()}`);
			const newHelia = await createHelia({ libp2p: newLibp2p, blockstore, datastore });
			console.log('✅ Fresh Helia instance created');

			// Create fresh OrbitDB instance
			const newOrbitDB = await createOrbitDB({
				ipfs: newHelia,
				id: `restored-instance-${Date.now()}`
			});
			console.log('✅ Fresh OrbitDB instance created:', newOrbitDB.id);

			// Step 2: Restore from Storacha backup
			status = 'Restoring database from Storacha backup...';
			console.log('🔄 Restoring database from Storacha backup...');

			const result = await restoreDatabaseFromSpace(newOrbitDB, {
				storachaKey,
				storachaProof,
				timeout: 60000
			});
			console.log('Restore result:', result);

			if (result.success) {
				// Step 3: Replace the current instances with the restored ones
				status = 'Replacing current database with restored data...';
				console.log('🔄 Replacing current database with restored data...');

				// Close existing instances (if any)
				try {
					if ($todoDBStore) {
						await $todoDBStore.close();
					}
				} catch (closeError) {
					console.warn('⚠️ Error closing existing database:', closeError);
				}

				// Update the stores with new instances
				libp2pStore.set(newLibp2p);
				peerIdStore.set(newLibp2p.peerId.toString());
				orbitDBStore.set(newOrbitDB);

				// Initialize database with the restored database
				await initializeDatabase(newOrbitDB, result.database, {
					enablePersistentStorage: true,
					enableNetworkConnection: true,
					enablePeerConnections: true
				});

				// Load todos from the restored database
				await loadTodos();

				showMessage(
					`Database restored successfully! ${result.entriesRecovered} entries recovered from Storacha space. Fresh OrbitDB instance created.`
				);

				console.log('🎉 Restore completed with fresh instance:', {
					newOrbitDBId: newOrbitDB.id,
					newPeerId: newLibp2p.peerId.toString(),
					restoredAddress: result.database.address,
					entriesRecovered: result.entriesRecovered
				});

			} else {
				// If restore failed, cleanup the new instances
				try {
					await newOrbitDB.stop();
					await newHelia.stop();
					await newLibp2p.stop();
				} catch (cleanupError) {
					console.warn('⚠️ Error cleaning up failed restore instances:', cleanupError);
				}
				showMessage(`Restore failed: ${result.error}`, 'error');
			}

		} catch (error) {
			console.error('❌ Restore failed:', error);
			showMessage(`Restore failed: ${error.message}`, 'error');
		} finally {
			isLoading = false;
			status = '';
			resetProgress();
		}
	}
</script>

<div
	class="mt-6 rounded-lg border border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50 p-4 dark:border-gray-600 dark:from-gray-700 dark:to-gray-600"
>
	<!-- Header -->
	<div class="mb-4 flex items-center justify-between">
		<div class="flex items-center space-x-2">
			<Cloud class="h-5 w-5 text-blue-600 dark:text-blue-400" />
			<h3 class="text-lg font-semibold text-gray-800 dark:text-white">Storacha Integration</h3>
		</div>

		<button
			on:click={() => (showStoracha = !showStoracha)}
			class="text-blue-600 transition-colors hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
		>
			{showStoracha ? 'Hide' : 'Show'}
		</button>
	</div>

	{#if showStoracha}
		<!-- Status Messages -->
		{#if error}
			<div
				class="mb-4 rounded-md border border-red-300 bg-red-100 p-3 dark:border-red-600 dark:bg-red-900/30"
			>
				<div class="flex items-center space-x-2">
					<AlertCircle class="h-4 w-4 text-red-600 dark:text-red-400" />
					<span class="text-sm text-red-700 dark:text-red-300">{error}</span>
				</div>
			</div>
		{/if}

		{#if success}
			<div
				class="mb-4 rounded-md border border-green-300 bg-green-100 p-3 dark:border-green-600 dark:bg-green-900/30"
			>
				<div class="flex items-center space-x-2">
					<CheckCircle class="h-4 w-4 text-green-600 dark:text-green-400" />
					<span class="text-sm text-green-700 dark:text-green-300">{success}</span>
				</div>
			</div>
		{/if}

		{#if status}
			<div
				class="mb-4 rounded-md border border-blue-300 bg-blue-100 p-3 dark:border-blue-600 dark:bg-blue-900/30"
			>
				<div class="flex items-center space-x-2">
					<Loader2 class="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />
					<span class="text-sm text-blue-700 dark:text-blue-300">{status}</span>
				</div>
			</div>
		{/if}

		<!-- Progress Bar -->
		{#if showProgress}
			<div
				class="mb-4 rounded-md border border-purple-300 bg-purple-100 p-3 dark:border-purple-600 dark:bg-purple-900/30"
			>
				<div class="mb-2 flex items-center justify-between text-sm">
					<span class="font-medium text-purple-800 dark:text-purple-200">
						{progressType === 'upload' ? 'Uploading' : 'Downloading'} Progress
					</span>
					<span class="text-purple-700 dark:text-purple-300">
						{progressPercentage}% ({progressCurrent}/{progressTotal})
					</span>
				</div>
				<div class="h-2 w-full rounded-full bg-purple-200 dark:bg-purple-700">
					<div
						class="h-2 rounded-full bg-purple-600 transition-all duration-300 ease-out dark:bg-purple-400"
						style="width: {progressPercentage}%"
					></div>
				</div>
				{#if progressCurrentBlock}
					<div class="mt-1 font-mono text-xs text-purple-600 dark:text-purple-400">
						{progressType === 'upload' ? 'Current block hash:' : 'Current CID:'}
						{progressType === 'upload'
							? progressCurrentBlock.hash?.slice(0, 16)
							: progressCurrentBlock.storachaCID?.slice(0, 16)}...
					</div>
				{/if}
				{#if progressError}
					<div class="mt-1 text-xs text-red-600 dark:text-red-400">
						Error: {progressError.message}
					</div>
				{/if}
			</div>
		{/if}

		{#if !isLoggedIn}
			<!-- Login Section -->
			<div class="space-y-4">
				<div class="text-center text-sm text-gray-600 dark:text-gray-300">
					Connect to Storacha to backup your todos to decentralized storage
				</div>

				<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
					<button
						on:click={() => {
							clearForms();
							showCreateForm = true;
						}}
						disabled={isLoading}
						class="flex items-center justify-center space-x-2 rounded-md bg-green-600 px-4 py-2 text-white transition-colors hover:bg-green-700 disabled:opacity-50"
					>
						<Mail class="h-4 w-4" />
						<span>Create New Account</span>
					</button>

					<button
						on:click={() => {
							clearForms();
							showCredentialsForm = true;
						}}
						disabled={isLoading}
						class="flex items-center justify-center space-x-2 rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
					>
						<Key class="h-4 w-4" />
						<span>Login with Credentials</span>
					</button>
				</div>

				<!-- Create Account Form -->
				{#if showCreateForm}
					<div class="rounded-md border bg-white p-4 dark:bg-gray-700">
						<h4 class="text-md mb-3 font-medium text-gray-800 dark:text-white">
							Create New Storacha Account
						</h4>
						<div class="space-y-3">
							<input
								bind:value={email}
								type="email"
								placeholder="Enter your email address"
								class="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
							/>
							<div class="flex space-x-2">
								<button
									on:click={handleEmailLogin}
									disabled={isLoading || !email.trim()}
									class="flex-1 rounded-md bg-green-600 px-4 py-2 text-white transition-colors hover:bg-green-700 disabled:opacity-50"
								>
									{isLoading ? 'Creating...' : 'Create Account'}
								</button>
								<button
									on:click={clearForms}
									class="rounded-md bg-gray-300 px-4 py-2 text-gray-700 transition-colors hover:bg-gray-400 dark:bg-gray-600 dark:text-gray-200 dark:hover:bg-gray-500"
								>
									Cancel
								</button>
							</div>
						</div>
					</div>
				{/if}

				<!-- Credentials Form -->
				{#if showCredentialsForm}
					<div class="rounded-md border bg-white p-4 dark:bg-gray-700">
						<h4 class="text-md mb-3 font-medium text-gray-800 dark:text-white">
							Login with Storacha Credentials
						</h4>
						<div class="space-y-3">
							<input
								bind:value={storachaKey}
								type="password"
								placeholder="Storacha Private Key"
								class="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
							/>
							<textarea
								bind:value={storachaProof}
								placeholder="Storacha Proof (delegation)"
								rows="3"
								class="w-full resize-none rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-xs text-gray-900 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
							></textarea>
							<div class="flex space-x-2">
								<button
									on:click={() => handleCredentialsLogin()}
									disabled={isLoading || !storachaKey.trim() || !storachaProof.trim()}
									class="flex-1 rounded-md bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
								>
									{isLoading ? 'Logging in...' : 'Login'}
								</button>
								<button
									on:click={clearForms}
									class="rounded-md bg-gray-300 px-4 py-2 text-gray-700 transition-colors hover:bg-gray-400 dark:bg-gray-600 dark:text-gray-200 dark:hover:bg-gray-500"
								>
									Cancel
								</button>
							</div>
						</div>
					</div>
				{/if}
			</div>
		{:else}
			<!-- Logged In Section -->
			<div class="space-y-4">
				<!-- Account Info -->
				<div
					class="flex items-center justify-between rounded-md border bg-white p-3 dark:bg-gray-700"
				>
					<div class="flex items-center space-x-3">
						<div
							class="flex h-8 w-8 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30"
						>
							<CheckCircle class="h-4 w-4 text-green-600 dark:text-green-400" />
						</div>
						<div>
							<div class="text-sm font-medium text-gray-800 dark:text-white">
								Connected to Storacha
							</div>
							{#if currentSpace}
								<div class="text-xs text-gray-500 dark:text-gray-400">
									Current space: {formatSpaceName(currentSpace)}
								</div>
							{/if}
						</div>
					</div>

					<button
						on:click={handleLogout}
						class="flex items-center space-x-1 px-3 py-1 text-sm text-red-600 transition-colors hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
					>
						<LogOut class="h-3 w-3" />
						<span>Logout</span>
					</button>
				</div>

				<!-- Action Buttons -->
				<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
					<button
						on:click={handleBackup}
						disabled={isLoading || !$initializationStore.isInitialized || $todosStore.length === 0}
						class="flex items-center justify-center space-x-2 rounded-md bg-green-600 px-4 py-2 text-white transition-colors hover:bg-green-700 disabled:opacity-50"
					>
						<Upload class="h-4 w-4" />
						<span>Backup Database</span>
					</button>

					<button
						on:click={restoreFromSpace}
						disabled={isLoading || !$initializationStore.isInitialized}
						class="flex items-center justify-center space-x-2 rounded-md bg-orange-600 px-4 py-2 text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
					>
						<Download class="h-4 w-4" />
						<span>Restore Database</span>
					</button>
				</div>

				<!-- Spaces Management -->
					<div class="rounded-md border bg-white p-4 dark:bg-gray-700">
						<h4
							class="text-md mb-3 flex items-center space-x-2 font-medium text-gray-800 dark:text-white"
						>
							<List class="h-4 w-4" />
							<span>Spaces ({spaces.length})</span>
						</h4>

						<!-- Create New Space -->
						<div class="mb-4 flex space-x-2">
							<input
								bind:value={newSpaceName}
								placeholder="New space name"
								class="flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
							/>
							<button
								on:click={handleCreateSpace}
								disabled={isLoading || !newSpaceName.trim()}
								class="rounded-md bg-green-600 px-3 py-2 text-white transition-colors hover:bg-green-700 disabled:opacity-50"
							>
								<Plus class="h-4 w-4" />
							</button>
						</div>

						<!-- Spaces List -->
						{#if spaces.length === 0}
							<div class="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
								No spaces found
							</div>
						{:else}
							<div class="max-h-40 space-y-2 overflow-y-auto">
								{#each spaces as space (space.did)}
									<div
										class="flex items-center justify-between rounded border bg-gray-50 p-2 dark:bg-gray-600"
									>
										<div>
											<div class="text-sm font-medium text-gray-800 dark:text-white">
												{formatSpaceName(space)}
											</div>
											<div class="font-mono text-xs text-gray-500 dark:text-gray-400">
												{space.did.slice(0, 20)}...
											</div>
										</div>
										{#if currentSpace?.did !== space.did}
											<button
												on:click={() => selectSpace(space)}
												class="px-2 py-1 text-sm text-blue-600 transition-colors hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
											>
												Select
											</button>
										{:else}
											<span
												class="px-2 py-1 text-sm font-medium text-green-600 dark:text-green-400"
											>
												Current
											</span>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>


			</div>
		{/if}
	{/if}
</div>



<style>
	/* Custom scrollbar for webkit browsers */
	.overflow-y-auto::-webkit-scrollbar {
		width: 4px;
	}

	.overflow-y-auto::-webkit-scrollbar-track {
		background: rgba(0, 0, 0, 0.1);
		border-radius: 2px;
	}

	.overflow-y-auto::-webkit-scrollbar-thumb {
		background: rgba(0, 0, 0, 0.3);
		border-radius: 2px;
	}

	.overflow-y-auto::-webkit-scrollbar-thumb:hover {
		background: rgba(0, 0, 0, 0.4);
	}
</style>
