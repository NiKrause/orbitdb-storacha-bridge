#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { logger } from '../lib/logger.js'

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const templatesDir = path.join(__dirname, 'svelte-templates-02');

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

class StorachaTestWithReplicationAutomator {
	constructor() {
		// Note: All files are now pre-copied to the svelte-templates-02/src/lib/ directory
		// This includes the cleaned-up StorachaTestWithReplication component with:
		// - Shared identities system for proper access control
		// - Cleaned up logging (professional but informative)
		// - Original IPFSAccessController (no debug wrapper needed)
		// - P2P replication with libp2p connectivity
		this.sourceFiles = new Map([
			// All files are already in the template - no copying needed
			// Just keeping this for validation purposes
		]);

		// Define template files to copy from the templates directory
		this.templateFiles = new Map([
			['package.json', 'package.json'],
			['vite.config.js', 'vite.config.js'],
			['src/routes/+layout.js', 'src/routes/+layout.js'],
			['src/routes/+page.svelte', 'src/routes/+page.svelte'],
			['src/routes/+layout.svelte', 'src/routes/+layout.svelte'],
			['src/app.css', 'src/app.css'],
			['src/app.html', 'src/app.html'],
			// Static assets
			['static/favicon.svg', 'static/favicon.svg'],
			['static/robots.txt', 'static/robots.txt'],
			// Technology logos
			['static/orbitdb.png', 'static/orbitdb.png'],
			['static/storacha-logo.jpeg', 'static/storacha-logo.jpeg'],
			['static/helia.svg', 'static/helia.svg'],
			['static/ipfs.png', 'static/ipfs.png'],
			['static/libp2p.png', 'static/libp2p.png'],
			['static/filecoin.svg', 'static/filecoin.svg'],
			['static/protocol-labs.png', 'static/protocol-labs.png']
		]);
	}

	async checkSourceFiles() {
		logger.info('📋 Checking template library files...');
		
		// Check that our pre-copied library files exist in the template
		const libraryFiles = [
			'src/lib/StorachaTestWithReplication.svelte',
			'src/lib/StorachaAuth.svelte', 
			'src/lib/orbitdb-storacha-bridge.js',
			'src/lib/utils.js',
			'src/lib/theme.js'
		];
		
		let foundCount = 0;
		for (const filePath of libraryFiles) {
			const fullPath = path.join(templatesDir, filePath);
			try {
				await fs.access(fullPath);
				logger.info(`✅ Found: ${filePath}`);
				foundCount++;
			} catch {
				logger.info(`⚠️  Missing: ${filePath}`);
			}
		}
		
		if (foundCount === 0) {
			logger.error('\n❌ No library files found in template. Cannot continue.');
			return false;
		}

		logger.info(`\n✅ Found ${foundCount} library files in template!`);
		return true;
	}

	async checkTemplateFiles() {
		logger.info('📋 Checking template files...');
		const missingTemplates = [];
		const foundTemplates = [];

		for (const [templatePath] of this.templateFiles) {
			const fullPath = path.join(templatesDir, templatePath);
			try {
				await fs.access(fullPath);
				logger.info(`✅ Found template: ${templatePath}`);
				foundTemplates.push(templatePath);
			} catch {
				logger.info(`⚠️  Missing template: ${templatePath}`);
				missingTemplates.push(templatePath);
			}
		}

		if (missingTemplates.length > 0) {
			logger.error('\n❌ Missing template files:');
			missingTemplates.forEach(file => logger.error(`   - ${file}`));
			logger.error('\n💡 Please ensure the svelte-templates-02 directory exists with all required files.');
			return false;
		}

		logger.info(`\n✅ Found all ${foundTemplates.length} template files!`);
		return true;
	}

	async createSvelteProject(projectName) {
		logger.info(`\n🚀 Creating SvelteKit project "${projectName}"`);

		// Check if directory exists
		try {
			await fs.access(projectName);
			const overwrite = await this.askUser(
				`⚠️  Directory "${projectName}" exists. Continue? (y/n): `
			);
			if (overwrite.toLowerCase() !== 'y') {
				return false;
			}
		} catch {
			// Directory doesn't exist - good!
		}

		const createCommand = `npx sv create ${projectName} --template minimal --types jsdoc --install npm --no-add-ons`;
		logger.info(`🔧 Running: ${createCommand}`);

		try {
			execSync(createCommand, { stdio: 'inherit' });
			process.chdir(projectName);

			logger.info('\n📦 Adding essential SvelteKit add-ons...');
			const addCommand = 'npx sv add prettier eslint vitest=usages:unit,component playwright tailwindcss=plugins:typography,form sveltekit-adapter=adapter:static --install npm --no-git-check';
			logger.info(`🔧 Running: ${addCommand}`);
			execSync(addCommand, { stdio: 'inherit' });

			return true;
		} catch (error) {
			logger.error('❌ Failed to create project:', error.message);
			return false;
		}
	}

	async copyTemplateFiles() {
		logger.info('🎨 Copying Svelte template files...');
		
		let copiedCount = 0;
		for (const [templatePath, destPath] of this.templateFiles) {
			const result = await this.copyTemplateFile(templatePath, destPath);
			if (result) copiedCount++;
		}

		logger.info(`✅ Copied ${copiedCount}/${this.templateFiles.size} template files`);
		return copiedCount;
	}

	async copyTemplateFile(templatePath, destPath) {
		const fullTemplatePath = path.join(templatesDir, templatePath);

		try {
			// Check if template file exists
			await fs.access(fullTemplatePath);

			// Ensure destination directory exists
			await this.ensureDirectory(path.dirname(destPath));

			// Check if this is a binary file based on extension
			const ext = path.extname(templatePath).toLowerCase();
			const binaryExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.eot'];
			const isBinary = binaryExtensions.includes(ext);

			if (isBinary) {
				// Copy binary files without encoding
				const content = await fs.readFile(fullTemplatePath);
				await fs.writeFile(destPath, content);
			} else {
				// Read text files as UTF-8
				const content = await fs.readFile(fullTemplatePath, 'utf-8');
				await fs.writeFile(destPath, content);
			}

			logger.info(`✅ Copied template: ${templatePath} → ${destPath}`);
			return true;
		} catch (error) {
			logger.info(
				`⚠️  Failed to copy template ${templatePath}: ${error.code === 'ENOENT' ? 'file not found' : error.message}`
			);
			return false;
		}
	}

	async copyFile(sourcePath, destPath) {
		const fullSourcePath = path.join(projectRoot, sourcePath);

		try {
			// Check if source file exists
			await fs.access(fullSourcePath);

			// Ensure destination directory exists
			await this.ensureDirectory(path.dirname(destPath));

			// Read the file content
			let content = await fs.readFile(fullSourcePath, 'utf-8');

			// Fix import paths for components
			if (sourcePath === 'src/components/StorachaTestWithReplication.svelte') {
				logger.info('🔧 Fixing import paths in StorachaTestWithReplication.svelte...');
				// Change ../../lib/orbitdb-storacha-bridge to ./orbitdb-storacha-bridge
				content = content.replace(
					"from '../../lib/orbitdb-storacha-bridge'",
					"from './orbitdb-storacha-bridge'"
				);
				// Fix other potential import paths
				content = content.replace(
					"from './orbitdb-storacha-bridge'",
					"from './orbitdb-storacha-bridge'"
				);
				logger.info('✅ Updated import paths in StorachaTestWithReplication.svelte');
			}
			
			if (sourcePath === 'src/components/StorachaAuth.svelte') {
				logger.info('🔧 Fixing import paths in StorachaAuth.svelte...');
				// Fix any import paths if needed
				content = content.replace(
					"from '../../lib/",
					"from './"
				);
				logger.info('✅ Updated import paths in StorachaAuth.svelte');
			}

			// Write the (potentially modified) content
			await fs.writeFile(destPath, content);

			logger.info(`✅ Copied: ${sourcePath} → ${destPath}`);
			return true;
		} catch (error) {
			logger.info(
				`⚠️  Skipped ${sourcePath}: ${error.code === 'ENOENT' ? 'file not found' : error.message}`
			);
			return false;
		}
	}

	async copyLibraryFiles() {
		logger.info('\n📚 Copying library files from template...');
		
		// Define the library files that need to be copied
		const libraryFiles = [
			'src/lib/StorachaTestWithReplication.svelte',
			'src/lib/StorachaAuth.svelte', 
			'src/lib/orbitdb-storacha-bridge.js',
			'src/lib/utils.js',
			'src/lib/theme.js',
			'src/lib/storacha-backup.js'
		];
		
		let copiedCount = 0;
		for (const filePath of libraryFiles) {
			const result = await this.copyTemplateFile(filePath, filePath);
			if (result) copiedCount++;
		}
		
		logger.info(`✅ Copied ${copiedCount}/${libraryFiles.length} library files`);
		return copiedCount;
	}

	async ensureDirectory(dirPath) {
		if (dirPath && dirPath !== '.' && dirPath !== '') {
			await fs.mkdir(dirPath, { recursive: true });
		}
	}

	async askUser(question) {
		return new Promise((resolve) => {
			rl.question(question, resolve);
		});
	}

	async run() {
		logger.info('🎯 OrbitDB Storacha Bridge - Svelte Replication Demo Generator');
		logger.info('================================================================\n');

		try {
			// Check source files
			const filesExist = await this.checkSourceFiles();
			if (!filesExist) {
				return;
			}

			// Check template files
			const templatesExist = await this.checkTemplateFiles();
			if (!templatesExist) {
				return;
			}

			await this.askUser('\n📖 Source files and templates verified. Press Enter to continue...');

			// Get project name from user
			const projectName =
				(await this.askUser('📝 Enter project name (default: orbitdb-storacha-svelte-replication-demo): ')) || 'orbitdb-storacha-svelte-replication-demo';

			// Step 1: Create SvelteKit project
			logger.info('\n' + '='.repeat(50));
			const projectCreated = await this.createSvelteProject(projectName);
			if (!projectCreated) {
				logger.info('❌ Project creation cancelled');
				return;
			}

			// Step 2: Copy template files (including package.json)
			logger.info('\n' + '='.repeat(50));
			const templatesCopied = await this.copyTemplateFiles();
			if (templatesCopied === 0) {
				logger.info('❌ No template files were copied. The demo may not work properly.');
				return;
			}

			// Step 3: Copy library files
			logger.info('\n' + '='.repeat(50));
			const copiedCount = await this.copyLibraryFiles();

			if (copiedCount === 0) {
				logger.info('❌ No library files were copied. The demo may not work properly.');
				return;
			}

			// Step 4: Install dependencies
			logger.info('\n' + '='.repeat(50));
			logger.info('📦 Installing dependencies (this will take a few minutes)...');
			try {
				execSync('npm install', { stdio: 'inherit' });
				logger.info('✅ All dependencies installed');
			} catch {
				logger.error('❌ Failed to install dependencies');
				logger.info('💡 Try running "npm install" manually in the project directory');
			}

			// Success!
			logger.info('\n' + '='.repeat(50));
			logger.info('🎉 STORACHA REPLICATION TEST DEMO COMPLETE! 🎉');
			logger.info('='.repeat(50));

			logger.info('\n📋 Your OrbitDB Storacha Replication Test Demo is ready!');
			logger.info('\n🚀 Next steps:');
			logger.info('   1. Run: npm run dev');
			logger.info('   2. Open http://localhost:5173 in your browser');
			logger.info('   3. The StorachaTestWithReplication component will be displayed');
			logger.info('   4. You can test backup/restore functionality with P2P replication');

			logger.info('\n💡 Features:');
			logger.info('   • Alice & Bob connect via libp2p for real-time replication');
			logger.info('   • Shared database address ensures proper data sync');
			logger.info('   • Storacha backup/restore preserves replication ability');
			logger.info('   • Circuit relay configuration for peer discovery');

			const startServer = await this.askUser('\n🌐 Start the development server now? (y/n): ');

			if (startServer.toLowerCase() === 'y' || startServer.toLowerCase() === 'yes') {
				logger.info('\n🚀 Starting development server...');
				logger.info('💡 Open http://localhost:5173 to see the StorachaTestWithReplication component!\n');

				try {
					execSync('npm run dev', { stdio: 'inherit' });
				} catch {
					logger.info('\n✅ Development server stopped.');
				}
			} else {
				logger.info("\n✨ Run `npm run dev` when you're ready to test the replication demo!");
			}
		} catch (error) {
			logger.error('\n❌ Demo creation failed:', error.message);
			logger.error('\n🔧 You may need to complete the remaining steps manually.');
		} finally {
			rl.close();
		}
	}
}

// Execute the automation
const automator = new StorachaTestWithReplicationAutomator();
import { logger } from '../lib/logger.js'
automator.run().catch((error) => {
	logger.error('Fatal error:', error);
	process.exit(1);
});