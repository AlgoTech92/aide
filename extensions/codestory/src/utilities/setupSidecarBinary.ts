/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { workspace, window, ProgressLocation, extensions, env } from 'vscode';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import { spawn, exec, execFile } from 'child_process';
import { downloadFromGCPBucket, downloadUsingURL } from './gcpBucket';
import { sidecarUseSelfRun } from './sidecarUrl';


function unzipSidecarZipFolder(source: string, extractDir: string) {
	if (source.endsWith('.zip')) {
		if (process.platform === 'win32') {
			cp.spawnSync('powershell.exe', [
				'-NoProfile',
				'-ExecutionPolicy', 'Bypass',
				'-NonInteractive',
				'-NoLogo',
				'-Command',
				`Microsoft.PowerShell.Archive\\Expand-Archive -Path "${source}" -DestinationPath "${extractDir}"`
			]);
		} else {
			cp.spawnSync('unzip', ['-o', source, '-d', `${extractDir}`]);
		}
	} else {
		// tar does not create extractDir by default
		if (!fs.existsSync(extractDir)) {
			fs.mkdirSync(extractDir);
		}
		cp.spawnSync('tar', ['-xzf', source, '-C', extractDir, '--strip-components', '1']);
	}
}

// We are going to use a static port right now and nothing else
export function getSidecarBinaryURL() {
	return 'http://127.0.0.1:42424';
}

// We are hardcoding the version of the sidecar binary here, so we can figure out
// if the version we are looking at is okay, or we need to download a new binary
// for now, lets keep it as it is and figure out a way to update the hash on
// important updates
export const SIDECAR_VERSION = 'f9da7f2a7aed0f7cc411bf048b13aca08734b5a379f08af6de45636dab6df281';

async function checkCorrectVersionRunning(url: string): Promise<boolean> {
	try {
		console.log('Version check startin');
		const response = await fetch(`${url}/api/version`);
		console.log('Version check done' + response);
		const version = await response.json();
		console.log('version content');
		console.log(version);
		return version.version_hash === SIDECAR_VERSION;
	} catch (e) {
		return false;
	}
}

export async function runCommand(cmd: string): Promise<[string, string | undefined]> {
	let stdout = '';
	let stderr = '';
	try {
		const output = await promisify(exec)(cmd, {
			shell: process.platform === 'win32' ? 'powershell.exe' : undefined,
		});
		stdout = output.stdout;
		stderr = output.stderr;
	} catch (e: any) {
		stderr = e.stderr;
		stdout = e.stdout;
	}

	const stderrOrUndefined = stderr === '' ? undefined : stderr;
	return [stdout, stderrOrUndefined];
}

async function checkServerRunning(serverUrl: string): Promise<boolean> {
	try {
		console.log('Health check starting');
		const response = await fetch(`${serverUrl}/api/health`);
		if (response.status === 200) {
			console.log('Sidecar server already running');
			console.log('Health check done');
			return true;
		} else {
			console.log('Health check done');
			return false;
		}
	} catch (e) {
		return false;
	}
}

function killProcessOnPort(port: number) {
	// Find the process ID using lsof (this command is for macOS/Linux)
	exec(`lsof -i :${port} | grep LISTEN | awk '{print $2}'`, (error, stdout) => {
		if (error) {
			console.error(`exec error: ${error}`);
			return;
		}

		const pid = stdout.trim();

		if (pid) {
			// Kill the process
			execFile('kill', ['-2', `${pid}`], (killError) => {
				if (killError) {
					console.error(`Error killing process: ${killError}`);
					return;
				}
				console.log(`Killed process with PID: ${pid}`);
			});
		} else {
			console.log(`No process running on port ${port}`);
		}
	});
}

async function checkOrKillRunningServer(serverUrl: string): Promise<boolean> {
	const serverRunning = await checkServerRunning(serverUrl);
	if (serverRunning) {
		console.log('Killing previous sidecar server');
		try {
			killProcessOnPort(42424);
		} catch (e: any) {
			if (!e.message.includes('Process doesn\'t exist')) {
				console.log('Failed to kill old server:', e);
			}
		}
	}
	return false;
}

export async function startSidecarBinary(
	extensionBasePath: string,
): Promise<string> {
	console.log('starting sidecar binary');
	// Check vscode settings
	const serverUrl = getSidecarBinaryURL();
	const shouldUseSelfRun = sidecarUseSelfRun();
	if (shouldUseSelfRun) {
		return serverUrl;
	}
	if (serverUrl !== 'http://127.0.0.1:42424') {
		console.log('Sidecar server is being run manually, skipping start');
		return 'http://127.0.0.1:42424';
	}

	// Check if we are running the correct version, or else we download a new version
	if (await checkCorrectVersionRunning(serverUrl)) {
		console.log('Correct version of Sidecar binary is running');
		return 'http://127.0.0.1:42424';
	}

	// First let's kill the running version
	console.log('Killing running Sidecar binary');
	await checkOrKillRunningServer(serverUrl);

	console.log('Starting Sidecar binary right now');

	// Download the server executable
	const bucket = 'sidecar-bin';
	const fileName =
		os.platform() === 'win32'
			? 'windows/sidecar.zip'
			: os.platform() === 'darwin'
				? 'mac/sidecar.zip'
				: 'linux/sidecar.zip';

	const zipDestination = path.join(
		extensionBasePath,
		'sidecar_zip.zip',
	);
	const sidecarDestination = path.join(
		extensionBasePath,
		'sidecar_bin',
	);

	// First, check if the server is already downloaded
	console.log('Downloading the sidecar binary...');
	await window.withProgress(
		{
			location: ProgressLocation.SourceControl,
			title: 'Downloading the sidecar binary 🦀',
			cancellable: false,
		},
		async () => {
			try {
				await downloadFromGCPBucket(bucket, fileName, zipDestination);
			} catch (e) {
				console.log('Failed to download from GCP bucket, trying using URL: ', e);
				await downloadUsingURL(bucket, fileName, zipDestination);
			}
		}
	);

	console.log(`Downloaded sidecar zip at ${zipDestination}`);
	// Now we need to unzip the folder in the location and also run a few commands
	// for the dylib files and the binary
	// -o is important here because we want to override the downloaded binary
	// if it has been already downloaded
	console.log(zipDestination);
	console.log(sidecarDestination);
	// hopefully this works as we want it to
	unzipSidecarZipFolder(zipDestination, sidecarDestination);
	// now delete the zip file
	fs.unlinkSync(zipDestination);
	// Get name of the corresponding executable for platform

	const webserverPath = path.join(sidecarDestination, 'target', 'release', 'webserver');

	if (os.platform() === 'darwin' || os.platform() === 'linux') {
		// Now we want to change the permissions for the following files:
		// target/release/webserver
		// qdrant/qdrant_mac
		// onnxruntime/libonnxruntime.dylib
		const qdrantPath = path.join(sidecarDestination, 'qdrant', 'qdrant_mac');
		const onnxPath = path.join(sidecarDestination, 'onnxruntime', 'libonnxruntime.dylib');
		fs.chmodSync(webserverPath, 0o7_5_5);
		fs.chmodSync(qdrantPath, 0o7_5_5);
		fs.chmodSync(onnxPath, 0o7_5_5);
	}

	if (os.platform() === 'darwin') {
		// We need to run this command on the darwin platform
		await runCommand(`xattr -dr com.apple.quarantine ${webserverPath}`);
		const qdrantPath = path.join(sidecarDestination, 'qdrant', 'qdrant_mac');
		await runCommand(`xattr -dr com.apple.quarantine ${qdrantPath}`);
		const onnxPath = path.join(sidecarDestination, 'onnxruntime', 'libonnxruntime.dylib');
		await runCommand(`xattr -dr com.apple.quarantine ${onnxPath}`);
	}


	// Validate that the file exists
	if (!fs.existsSync(webserverPath)) {
		const errText = `- Failed to install Sidecar binary.`;
		window.showErrorMessage(errText);
		throw new Error(errText);
	}

	// Run the executable
	console.log('Starting sidecar binary');
	let attempts = 0;
	const maxAttempts = 5;
	const delay = 1000; // Delay between each attempt in milliseconds

	const spawnChild = async () => {
		const retry = () => {
			attempts++;
			console.log(`Error caught (likely EBUSY). Retrying attempt ${attempts}...`);
			setTimeout(spawnChild, delay);
		};
		try {
			// NodeJS bug requires not using detached on Windows, otherwise windowsHide is ineffective
			// Otherwise, detach is preferable
			const windowsSettings = {
				windowsHide: true,
			};
			const macLinuxSettings = {
				detached: true,
				stdio: 'ignore',
			};
			const settings: any = os.platform() === 'win32' ? windowsSettings : macLinuxSettings;

			const qdrantDirectory = path.join(sidecarDestination, 'qdrant');
			const dylibDirectory = path.join(sidecarDestination, 'onnxruntime');
			const modelDirectory = path.join(sidecarDestination, 'models', 'all-MiniLM-L6-v2');
			const sidecarBinary = path.join(sidecarDestination, 'target', 'release', 'webserver');
			const args = ['--qdrant-binary-directory', qdrantDirectory, '--dylib-directory', dylibDirectory, '--model-dir', modelDirectory, '--qdrant-url', 'http://127.0.0.1:6334'];
			console.log('what are the args');
			console.log(args, sidecarBinary);
			const child = spawn(sidecarBinary, args, settings);

			// Either unref to avoid zombie process, or listen to events because you can
			if (os.platform() === 'win32') {
				child.stdout.on('data', (data: any) => {
					// console.log(`stdout: ${data}`);
				});
				child.stderr.on('data', (data: any) => {
					console.log(`stderr: ${data}`);
				});
				child.on('error', (err: any) => {
					if (attempts < maxAttempts) {
						retry();
					} else {
						console.error('Failed to start subprocess.', err);
					}
				});
				child.on('exit', (code: any, signal: any) => {
					console.log('Subprocess exited with code', code, signal);
				});
				child.on('close', (code: any, signal: any) => {
					console.log('Subprocess closed with code', code, signal);
				});
			} else {
				child.unref();
			}
		} catch (e: any) {
			console.log('Error starting server:', e);
			retry();
		}
	};

	await spawnChild();


	let hcAttempts = 0;
	const waitForGreenHC = async () => {
		const retry = () => {
			hcAttempts++;
			console.log(`Error HC failed, probably still starting up. Retrying attempt ${hcAttempts}...`);
			setTimeout(waitForGreenHC, delay);
		};
		try {

			console.log('Health check main loop');
			const url = `${serverUrl}/api/health`;
			const response = await fetch(url);
			if (response.status === 200) {
				console.log('HC finished! We are green 🛳️');
				return;
			} else {
				console.log('HC failed, trying again');
				retry();
			}
		} catch (e: any) {
			if (hcAttempts < maxAttempts) {
				console.log('HC failed, trying again', e);
				retry();
			} else {
				throw e;
			}
		}
	};

	console.log('we are returning from HC check');
	await waitForGreenHC();
	console.log('we are in the HC check');

	return 'http://127.0.0.1:42424';
}
