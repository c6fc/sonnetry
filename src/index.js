'use strict';

const fs = require("fs");
const os = require("os");
const aws = require("aws-sdk");
const ini = require("ini");
const path = require("path");
const readline = require("readline");
const terraform = require("@jahed/terraform");
const { Jsonnet } = require("@hanazuki/node-jsonnet");

// console.log(terraform);

aws.config.update({
	region: "us-east-1"
});

exports.Sonnet = class {
	renderPath; cleanBeforeRender; jsonnet; lastRender;
	constructor(options) {
		options.renderPath ??= "./render";
		options.cleanBeforeRender ??= false;

		try {
			if (!fs.existsSync(options.renderPath)) {
				fs.mkdirSync(options.renderPath);
			}
		} catch (e) {
			throw new Error(`Sonnetry Error: renderPath could not be created. ${e}`);
		}

		this.renderPath = options.renderPath;
		this.cleanBeforeRender = options.cleanBeforeRender;

		this.jsonnet = new Jsonnet()
			.addJpath(path.join(__dirname, '../lib'))
			.nativeCallback("aws", (clientObj, method, params) => {
				clientObj = JSON.parse(clientObj);

				const client = new aws[clientObj.service](clientObj.params);

				return client[method](JSON.parse(params)).promise();
			}, "clientObj", "method", "params");

		return this;
	}

	async auth() {
		return await setAwsCredentials();
	}

	import(path) {
		this.jsonnet = this.jsonnet.addJpath(path);

		return this;
	}

	async render(file) {
		if (!fs.existsSync(file)) {
			throw new Error("Sonnetry Error: renderFile does not exist.");
		}

		this.renderPath = (this.renderPath.split("").slice(-1)[0] == "/") ?
			this.renderPath.split("").slice(0, -1).join("") :
			this.renderPath;

		this.lastRender = JSON.parse(await this.jsonnet.evaluateFile(file));

		return this.lastRender;
	}

	write(files = this.lastRender) {
		try {
			if (!fs.existsSync(this.renderPath)) {
				fs.mkdirSync(this.renderPath);
			}
		} catch (e) {
			throw new Error(`Sonnetry Error: renderPath could not be created. ${e}`);
		}

		if (this.cleanBeforeRender) {
			try {
				let regex = /^\.terraform.*?$/
				fs.readdirSync(this.renderPath)
					.filter(f => !regex.test(f))
					.map(f => fs.unlinkSync(`${this.renderPath}/${f}`));
			} catch (e) {
				console.log(`[!] Failed to remove files from renderPath. ${e}`);
				process.exit(1);
			}
		}

		try {
			for (const filename in files) {
				const outputPath = `${this.renderPath}/${filename}`;
				fs.writeFileSync(outputPath, JSON.stringify(files[filename], null, 4));
				console.log(outputPath);
			}
		} catch (e) {
			console.log(`[!] Failed to write to renderPath. ${e}`);
			process.exit(1);
		}

		return this;
	}
}

async function verifyCredentials() {
	const sts = new aws.STS();

	try {
		const caller = await sts.getCallerIdentity().promise();
		return caller;
	} catch (e) {
		console.log(`[!] Credential validation failed with error: ${e}`);
		return false;
	}
}

async function setAwsCredentials() {

	let profile = process.env.AWS_PROFILE;

	if (!profile) {

		const caller = await verifyCredentials();
		if (!!caller) {
			console.log(`[+] Using ${caller.arn}`)
			return true;
		}

		console.log(`[!] No profile was specified, and the default credential context is invalid.`);

		process.exit(1);
	}

	delete process.env.AWS_PROFILE;
	delete process.env.AWS_ACCESS_KEY_ID;
	delete process.env.AWS_SECRET_ACCESS_KEY;
	delete process.env.AWS_SESSION_TOKEN;

	if (!fs.existsSync(`${os.homedir()}/.aws/credentials`)) {
		console.log("[!] The default credential file is missing. Have you configured the AWS CLI yet?");
		process.exit(1);
	}

	const credfile = ini.parse(fs.readFileSync(`${os.homedir()}/.aws/credentials`, 'utf-8'));

	if (!credfile[profile]) {
		console.log(`[!] AWS Profile [${profile}] isn't set.`);
		process.exit(1);
	}

	const creds = credfile[profile];
	const cacheFile = `${os.homedir()}/.aws/profile_cache.json`;

	// Use long-term creds if they're present. Remove the cache if successful.
	if (!!creds.aws_access_key_id && !!creds.aws_secret_access_key) {
		try {
		
			aws.config.update({
				credentials: {
					accessKeyId: creds.aws_access_key_id,
					secretAccessKey: creds.aws_secret_access_key
				}
			});

			process.env.AWS_ACCESS_KEY_ID = creds.aws_access_key_id;
			process.env.AWS_SECRET_ACCESS_KEY = creds.aws_secret_access_key;

			let valid = await verifyCredentials();

			if (!valid) {
				throw "Verification Error";
			}

			if (fs.existsSync(cacheFile)) {
				fs.unlinkSync(cacheFile);
			}

			return true;

		} catch (e) {
			console.log(`[!] Long term credentials for profile [${profile}] are invalid: ${e}`);
			process.exit(1);
		}
	}

	// Initialize and test the cache before trying to assume the role in the profile.
	let cache;

	try {

		cache = (fs.existsSync(cacheFile)) ? JSON.parse(fs.readFileSync(cacheFile)) : {};

		if (cache.profile == profile) {
			if (cache.expireTime > Date.now() + 2700000) {

				aws.config.update({
					credentials: cache
				});

				let valid = await verifyCredentials();

				if (!valid) {
					throw "Verification Error";
				}

				console.log(`[+] Successfully resumed session as ${cache.profile}; Valid for ${((cache.expireTime - Date.now()) / 60000).toFixed(0)} minutes.`);

				return true;
			}

			console.log(`[!] Cache expires in ${((cache.expireTime - Date.now()) / 60000).toFixed(0)} minutes. Skipping.`);
		}

	} catch (e) {
		console.log(e);
		cache = {};
	}

	if (!!creds.role_arn && !!creds.source_profile) {
		aws.config.update({
			credentials: {
				accessKeyId: credfile[creds.source_profile].aws_access_key_id,
				secretAccessKey: credfile[creds.source_profile].aws_secret_access_key
			}
		});

		const parameters = {
			RoleArn: creds.role_arn,
			RoleSessionName: `sonnetry_assumerole_${Date.now()}`,
			DurationSeconds: creds.duration_seconds || 3600
		}

		if (!!creds.mfa_serial) {
			parameters.SerialNumber = creds.mfa_serial;
			parameters.TokenCode = await getMFAToken(creds.mfa_serial);
		}

		try {
			const sts = new aws.STS();
			const role = await sts.assumeRole(parameters).promise();

			aws.config.credentials = sts.credentialsFrom(role);

			let valid = await verifyCredentials();

			if (!valid) {
				throw "Verification Error";
			}

			console.log(`[+] Successfully assumed role [${creds.role_arn}]`);

			fs.writeFileSync(cacheFile, JSON.stringify({
				accessKeyId: aws.config.credentials.accessKeyId,
				secretAccessKey: aws.config.credentials.secretAccessKey,
				sessionToken: aws.config.credentials.sessionToken,
				expireTime: new Date(aws.config.credentials.expireTime).getTime(),
				expired: aws.config.credentials.expired,
				profile
			}), { mode: '600' });

			process.env.AWS_ACCESS_KEY_ID = aws.config.credentials.accessKeyId;
			process.env.AWS_SECRET_ACCESS_KEY = aws.config.credentials.secretAccessKey;
			process.env.AWS_SESSION_TOKEN = aws.config.credentials.sessionToken ?? '';

			return true;

		} catch(e) {
			console.log(`[!] Failed to assume role ${creds.role_arn} via profile ${creds.source_profile}: ${e}`);
			process.exit(1);
		}
	}
}

function getMFAToken(mfaSerial) {
	return new Promise((success, failure) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout
		});

		rl.question(`Enter MFA code for ${mfaSerial}: `, function(token) {
			rl.close();

			if (!token) {
				return getMFAToken(mfaSerial);
			}

			return success(token);
		});
	});
}