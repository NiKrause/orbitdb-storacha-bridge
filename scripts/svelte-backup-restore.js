#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const templatesDir = path.join(__dirname, 'svelte-templates');

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

class StorachaTestAutomator {
	constructor() {
		// Define the files we need from the current orbitdb-storacha-bridge project
		this.sourceFiles = new Map([
			// Core library files
			['lib/orbitdb-storacha-bridge.js', 'src/lib/orbitdb-storacha-bridge.js'],
			['lib/utils.js', 'src/lib/utils.js'],
			
			// Svelte components and related files
			['src/components/StorachaTest.svelte', 'src/lib/StorachaTest.svelte'],
			['src/components/StorachaTestWithWebAuthn.svelte', 'src/lib/StorachaTestWithWebAuthn.svelte'],
			['src/components/WebAuthnDIDProvider.js', 'src/lib/WebAuthnDIDProvider.js'],
			['src/components/storacha-backup.js', 'src/lib/storacha-backup.js'],
			['src/components/StorachaAuth.svelte', 'src/lib/StorachaAuth.svelte'],
			['src/components/theme.js', 'src/lib/theme.js']
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
		console.log('📋 Checking source files...');
		const missingFiles = [];
		const foundFiles = [];

		for (const [sourcePath] of this.sourceFiles) {
			const fullPath = path.join(projectRoot, sourcePath);
			try {
				await fs.access(fullPath);
				console.log(`✅ Found: ${sourcePath}`);
				foundFiles.push(sourcePath);
			} catch {
				console.log(`⚠️  Missing: ${sourcePath}`);
				missingFiles.push(sourcePath);
			}
		}

		if (foundFiles.length === 0) {
			console.error('\n❌ No source files found. Cannot continue.');
			return false;
		}

		console.log(`\n✅ Found ${foundFiles.length} source files!`);
		if (missingFiles.length > 0) {
			console.log(`⚠️  ${missingFiles.length} files missing (will be created or skipped)`);
		}

		return true;
	}

	async checkTemplateFiles() {
		console.log('📋 Checking template files...');
		const missingTemplates = [];
		const foundTemplates = [];

		for (const [templatePath] of this.templateFiles) {
			const fullPath = path.join(templatesDir, templatePath);
			try {
				await fs.access(fullPath);
				console.log(`✅ Found template: ${templatePath}`);
				foundTemplates.push(templatePath);
			} catch {
				console.log(`⚠️  Missing template: ${templatePath}`);
				missingTemplates.push(templatePath);
			}
		}

		if (missingTemplates.length > 0) {
			console.error('\n❌ Missing template files:');
			missingTemplates.forEach(file => console.error(`   - ${file}`));
			console.error('\n💡 Please ensure the svelte-templates directory exists with all required files.');
			return false;
		}

		console.log(`\n✅ Found all ${foundTemplates.length} template files!`);
		return true;
	}

	async createSvelteProject(projectName) {
		console.log(`\n🚀 Creating SvelteKit project "${projectName}"`);

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
		console.log(`🔧 Running: ${createCommand}`);

		try {
			execSync(createCommand, { stdio: 'inherit' });
			process.chdir(projectName);

			console.log('\n📦 Adding essential SvelteKit add-ons...');
			const addCommand = 'npx sv add prettier eslint vitest=usages:unit,component playwright tailwindcss=plugins:typography,form sveltekit-adapter=adapter:static --install npm --no-git-check';
			console.log(`🔧 Running: ${addCommand}`);
			execSync(addCommand, { stdio: 'inherit' });

			return true;
		} catch (error) {
			console.error('❌ Failed to create project:', error.message);
			return false;
		}
	}

	async copyTemplateFiles() {
		console.log('🎨 Copying Svelte template files...');
		
		let copiedCount = 0;
		for (const [templatePath, destPath] of this.templateFiles) {
			const result = await this.copyTemplateFile(templatePath, destPath);
			if (result) copiedCount++;
		}

		console.log(`✅ Copied ${copiedCount}/${this.templateFiles.size} template files`);
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

			console.log(`✅ Copied template: ${templatePath} → ${destPath}`);
			return true;
		} catch (error) {
			console.log(
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
			if (sourcePath === 'src/components/StorachaTest.svelte') {
				console.log('🔧 Fixing import paths in StorachaTest.svelte...');
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
				console.log('✅ Updated import paths in StorachaTest.svelte');
			}
			
			if (sourcePath === 'src/components/StorachaTestWithWebAuthn.svelte') {
				console.log('🔧 Fixing import paths in StorachaTestWithWebAuthn.svelte...');
				// Change ../../lib/ to ./
				content = content.replace(
					/from ['"]\.\.?\/\.\.?\/lib\//g,
					"from './"
				);
				console.log('✅ Updated import paths in StorachaTestWithWebAuthn.svelte');
			}
			
			if (sourcePath === 'src/components/StorachaAuth.svelte') {
				console.log('🔧 Fixing import paths in StorachaAuth.svelte...');
				// Fix any import paths if needed
				content = content.replace(
					"from '../../lib/",
					"from './"
				);
				console.log('✅ Updated import paths in StorachaAuth.svelte');
			}

			// Write the (potentially modified) content
			await fs.writeFile(destPath, content);

			console.log(`✅ Copied: ${sourcePath} → ${destPath}`);
			return true;
		} catch (error) {
			console.log(
				`⚠️  Skipped ${sourcePath}: ${error.code === 'ENOENT' ? 'file not found' : error.message}`
			);
			return false;
		}
	}

	async copyLibraryFiles() {
		console.log('\n📚 Copying OrbitDB-Storacha library files...');
		
		let copiedCount = 0;
		for (const [sourcePath, destPath] of this.sourceFiles) {
			const result = await this.copyFile(sourcePath, destPath);
			if (result) copiedCount++;
		}

		console.log(`✅ Copied ${copiedCount}/${this.sourceFiles.size} library files`);
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
		console.log('🎯 OrbitDB Storacha Bridge - Svelte Demo Project Generator');
		console.log('================================================\n');

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
				(await this.askUser('📝 Enter project name (default: orbitdb-storacha-svelte-backup-restore-demo): ')) || 'orbitdb-storacha-svelte-backup-restore-demo';

			// Step 1: Create SvelteKit project
			console.log('\n' + '='.repeat(50));
			const projectCreated = await this.createSvelteProject(projectName);
			if (!projectCreated) {
				console.log('❌ Project creation cancelled');
				return;
			}

			// Step 2: Copy template files (including package.json)
			console.log('\n' + '='.repeat(50));
			const templatesCopied = await this.copyTemplateFiles();
			if (templatesCopied === 0) {
				console.log('❌ No template files were copied. The demo may not work properly.');
				return;
			}

			// Step 3: Copy library files
			console.log('\n' + '='.repeat(50));
			const copiedCount = await this.copyLibraryFiles();

			if (copiedCount === 0) {
				console.log('❌ No library files were copied. The demo may not work properly.');
				return;
			}

			// Step 4: Install dependencies
			console.log('\n' + '='.repeat(50));
			console.log('📦 Installing dependencies (this will take a few minutes)...');
			try {
				execSync('npm install', { stdio: 'inherit' });
				console.log('✅ All dependencies installed');
			} catch {
				console.error('❌ Failed to install dependencies');
				console.log('💡 Try running "npm install" manually in the project directory');
			}

			// Success!
			console.log('\n' + '='.repeat(50));
			console.log('🎉 STORACHA TEST DEMO COMPLETE! 🎉');
			console.log('='.repeat(50));

			console.log('\n📋 Your OrbitDB Storacha Test Demo is ready!');
			console.log('\n🚀 Next steps:');
			console.log('   1. Run: npm run dev');
			console.log('   2. Open http://localhost:5173 in your browser');
			console.log('   3. The StorachaTest component will be displayed');
			console.log('   4. You can test backup/restore functionality with Storacha');

			console.log('\n💡 Requirements:');
			console.log('   • You\'ll need Storacha credentials to run tests');
			console.log('   • The test will create, backup, and restore OrbitDB data');

			const startServer = await this.askUser('\n🌐 Start the development server now? (y/n): ');

			if (startServer.toLowerCase() === 'y' || startServer.toLowerCase() === 'yes') {
				console.log('\n🚀 Starting development server...');
				console.log('💡 Open http://localhost:5173 to see the StorachaTest component!\n');

				try {
					execSync('npm run dev', { stdio: 'inherit' });
				} catch {
					console.log('\n✅ Development server stopped.');
				}
			} else {
				console.log("\n✨ Run `npm run dev` when you're ready to test the demo!");
			}
		} catch (error) {
			console.error('\n❌ Demo creation failed:', error.message);
			console.error('\n🔧 You may need to complete the remaining steps manually.');
		} finally {
			rl.close();
		}
	}
}

// Execute the automation
const automator = new StorachaTestAutomator();
automator.run().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
