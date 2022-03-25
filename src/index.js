'use strict';

/*
	Check if @jahed/terraform is present.
	It's done this way to allow arbitrary
	versions without causing dependency
	issues.
*/

try {
	require.resolve('@jahed/terraform/package.json');
} catch (e) {
	console.log(`[!] Missing package @jahed/terraform. Use NPM to install this package using the Terraform version you require.`);
	process.exit(1);
}

const terraform = require('@jahed/terraform');

const fs = require("fs");
const os = require("os");
const aws = require("aws-sdk");
const ini = require("ini");
const path = require("path");
const crypto = require('crypto');
const readline = require("readline");
const { spawnSync } = require('child_process');
const { Jsonnet } = require("@hanazuki/node-jsonnet");

aws.config.update({
	region: process.env?.AWS_DEFAULT_REGION ?? "us-east-1"
});

exports.Sonnet = class {
	renderPath; cleanBeforeRender; jsonnet; lastRender; terraformBinPath; projectName; identity; activePath;
	
	projectName = false;
	bootstrapBucket = false;
	bootstrapLocation = false;

	constructor(options) {

		options.renderPath ??= "./render";
		options.cleanBeforeRender ??= false;

		this.cache = {};

		const terraformModulePath = require.resolve('@jahed/terraform/package.json').split('/node_modules/')[0];
		const terraformExecPath = terraform.path.split('/node_modules/')[1];

		this.terraformBinPath = `${terraformModulePath}/node_modules/${terraformExecPath}`;

		this.renderPath = options.renderPath;
		this.cleanBeforeRender = options.cleanBeforeRender;

		this.jsonnet = new Jsonnet()
			.addJpath(path.join(__dirname, '../lib'));

		this.addFunction("aws", (clientObj, method, params) => {
			clientObj = JSON.parse(clientObj);

			const client = new aws[clientObj.service](clientObj.params);

			return client[method](JSON.parse(params)).promise();
		}, "clientObj", "method", "params");

		this.addFunction("bootstrap", (project) => {
			return this.bootstrap(project);
		}, "project");

		this.addFunction("envvar", (name) => {
			return process.env?.[name] ?? false;
		}, "name");

		this.addFunction("path", () => {
			return `${process.cwd()}`;
		});

		this.aws = aws;

		return this;
	}

	_cacheKey(...args) {
		return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
	}

	addFunction(name, fn, ...parameters) {
		this.jsonnet.nativeCallback(name, (...args) => {

			let key = this._cacheKey(name, args);
			if (!!this.cache?.[key]) {
				return this.cache[key];
			}

			this.cache[key] = fn(...args);

			return this.cache[key];
		}, ...parameters);
	}

	apply(skipInit = false, autoApprove = false, skipRefresh = false) {
		const args = [];

		if (autoApprove) {
			args.push('-auto-approve');
		}

		if (skipRefresh) {
			args.push('-refresh=false');
		}

		if (!skipInit) {
			const init = spawnSync(this.terraformBinPath, ['init'], {
				cwd: this.renderPath,
				stdio: [process.stdin, process.stdout, process.stderr]
			});

			if (init.status != 0) {
				console.log(`[!] Terraform provider initialization failed with status code ${init.status}`);
				process.exit(init.status);
			}
		}

		let apply = spawnSync(this.terraformBinPath, ['apply'].concat(args), {
			cwd: this.renderPath,
			stdio: [process.stdin, process.stdout, process.stderr]
		});

		if (apply.status != 0) {
			console.log(`[!] Terraform apply failed with status code ${apply.status}`);
			process.exit(apply.status);
		}

		console.log(`[+] Successfully applied`);
	}

	auth() {
		try {
			this.identity = setAwsCredentials();

			if (!!this.identity) {
				return true;
			}
		} catch (e) {
			console.trace(e);
		}
	}

	async getArtifact(name) {
		const self = this;

		if (!self.bootstrapBucket || !self.projectName) {
			return false;
		}

		const s3 = new aws.S3({ region: (self.bootstrapBucketLocation || 'us-east-1') });

		let object;

		try {
			object = await s3.getObject({
				Bucket: self.bootstrapBucket,
				Key: `sonnetry/${self.projectName}/artifacts/${name}`
			}).promise();
		} catch (e) {
			return false;
		}

		return object?.Body;
	}

	async getBootstrapBucket() {

		const s3 = new aws.S3();
		const buckets = await s3.listBuckets().promise();

		const arns = buckets.Buckets
			.map(e => e.Name)
			.filter(e => /^sonnetry-[a-z]*?-\d{10}$/.test(e));

		if (arns.length == 1) {
			return arns[0];
		}

		if (arns.length > 1) {
			console.log("[!] More than one bootstrap bucket exists in this account. Fix this before continuing.");
			return process.exit(1);
		}

		return false;
	}

	async bootstrap(project) {
		const s3 = new aws.S3();
		const self = this;
		
		let bucketName;
		let bootstrapBucket = await self.getBootstrapBucket();

		if (!bootstrapBucket) {
			bucketName = `sonnetry-${Math.random().toString(36).replace(/[^a-z]+/g, '')}-${Math.round(Date.now() / 1000)}`;

			try {
				await s3.createBucket({
					Bucket: bucketName
				}).promise();

				await s3.putBucketTagging({
					Bucket: bucketName,
					Tagging: {
						TagSet: [{
							Key: "sonnetry-backend",
							Value: "true"
						}]
					}
				}).promise();

				await s3.putBucketVersioning({
					Bucket: bucketName,
					VersioningConfiguration: {
						MFADelete: "Disabled",
						Status: "Enabled"
					}
				}).promise();

				await s3.putPublicAccessBlock({
					Bucket: bucketName,
					PublicAccessBlockConfiguration: {
						BlockPublicAcls: true,
						BlockPublicPolicy: true,
						IgnorePublicAcls: true,
						RestrictPublicBuckets: true
					}
				}).promise();
			} catch (e) {
				console.log(`Sonnetry error: Unable to create bucket: ${e}`);
				process.exit(1);
			}

			console.log(`[+] Created bootstrap bucket ${bucketName}`);

			bootstrapBucket = `arn:aws:s3:::${bucketName}`;
		} else {
			bucketName = bootstrapBucket; //.substr(13);
			console.log(`[+] Using bootstrap bucket ${bucketName}`);
		}

		let bootstrapLocation = await s3.getBucketLocation({
			Bucket: bucketName
		}).promise();

		bootstrapLocation = (bootstrapLocation.LocationConstraint == '') ? "us-east-1" : bootstrapLocation.LocationConstraint;

		this.projectName = project;
		this.bootstrapBucket = bootstrapBucket;
		this.bootstrapLocation = bootstrapLocation;

		return {
			terraform: {
				backend: {
					s3: {
						bucket: bucketName,
						key: `sonnetry/${project}/terraform.tfstate`,
						region: bootstrapLocation
					}
				}
			}
		}
	}

	destroy(skipInit = false, autoApprove = false) {

		const args = [];

		if (autoApprove) {
			args.push('-auto-approve');
		}

		if (!skipInit) {
			this.init();
		}

		const destroy = spawnSync(this.terraformBinPath, ['destroy'].concat(args), {
			cwd: this.renderPath,
			stdio: [process.stdin, process.stdout, process.stderr]
		});

		if (destroy.status != 0) {
			console.log(`[!] Terraform destroy failed with status code ${init.status}`);
			process.exit(destroy.status);
		}

		console.log(`[+] Successfully destroyed`);
	}

	export(name, value) {
		if (typeof value !== "string") {
			value = JSON.stringify(value);
		}

		this.jsonnet = this.jsonnet.extCode(name, value);
		return this;
	}

	import(path) {
		this.jsonnet = this.jsonnet.addJpath(path);

		return this;
	}

	init(args = []) {
		const init = spawnSync(this.terraformBinPath, ['init'].concat(args), {
			cwd: this.renderPath,
			stdio: [process.stdin, process.stdout, process.stderr]
		});

		if (init.status != 0) {
			throw new Error(`[!] Terraform init failed with status code ${init.status}`);
		}

		console.log(`[+] Successfully initialized`);
	}

	async render(file) {
		if (!fs.existsSync(file)) {
			throw new Error(`Sonnetry Error: ${file} does not exist.`);
		}

		this.activePath = path.dirname(path.resolve(file));

		const moduleFile = path.resolve(path.join(__dirname, '../lib/modules'));

		if (fs.existsSync(moduleFile)) {
			// throw new Error(`[!] The module target file [${moduleFile}] already exists. Remove or rename it before continuing.`);
		}

		this.loadModules(moduleFile);

		this.renderPath = (this.renderPath.split("").slice(-1)[0] == "/") ?
			this.renderPath.split("").slice(0, -1).join("") :
			this.renderPath;

		try {
			this.lastRender = JSON.parse(await this.jsonnet.evaluateFile(file));
		} catch (e) {
			throw new Error(`Error parsing Jsonnet file: ${e}`);
		}

		if (fs.existsSync(moduleFile)) {
			fs.unlinkSync(moduleFile);
		}

		return this.lastRender;
	}

	loadModules(moduleFile) {

		let registeredFunctions = [];

		const modulePath = path.join(this.activePath, 'sonnetry_modules');

		if (!fs.existsSync(modulePath)) {
			return [];
		}

		const regex = /.*?\.js$/
		const moduleList = fs.readdirSync(modulePath)
			.filter(f => regex.test(f));

		if (moduleList.length < 1) {
			return [];
		}

		let magicContent = [];

		moduleList.map(f => {
			const file = path.join(modulePath, f);

			try {
				const functions = require(file);

				registeredFunctions = registeredFunctions.concat(Object.keys(functions).map(e => {
					
					const [fn, ...parameters] = functions[e];

					magicContent.push(`\t${e}(${parameters.join(', ')}):: std.native('${e}')(${parameters.join(', ')})`);

					this.addFunction(e, fn, ...parameters);
					return e;
				}));

			} catch (e) {
				throw new Error(`Unable to register external module: ${e}`);
			}
		});

		fs.writeFileSync(moduleFile, `{\n${magicContent.join(",\n")}\n}`);

		console.log(`[+] Registered ${moduleList.length} module${(moduleList.length > 1) ? 's' : ''} comprising ${registeredFunctions.length} function${(registeredFunctions.length > 1) ? 's' : ''}: [ ${registeredFunctions.sort().join(', ')} ]`)

		return registeredFunctions;
	}

	async putArtifact(name, content) {
		const self = this;

		if (!self.bootstrapBucket || !self.projectName) {
			throw new Error('Cannot putArtifact before a project is bootstrapped.');
		}

		const s3 = new aws.S3({ region: self.bootstrapBucketLocation });

		let object;

		object = await s3.putObject({
			Bucket: self.bootstrapBucket,
			Key: `sonnetry/${self.projectName}/artifacts/${name}`,
			Body: content
		}).promise();

		return true;
	}

	toString() {
		if (this?.lastRender) {
			return this.lastRender
		}

		return null;
	}

	write(files = this.lastRender) {
		try {
			if (!fs.existsSync(this.renderPath)) {
				fs.mkdirSync(this.renderPath, { recursive: true });
			}
		} catch (e) {
			throw new Error(`Sonnetry Error: renderPath could not be created. ${e}`);
		}

		if (this.cleanBeforeRender) {
			try {
				let regex = /.*?\.tf\.json$/
				fs.readdirSync(this.renderPath)
					.filter(f => regex.test(f))
					.map(f => fs.unlinkSync(`${this.renderPath}/${f}`));
			} catch (e) {
				throw new Error(`Failed to remove *.tf.json files from renderPath. ${e}`);
			}
		}

		try {
			for (const filename in files) {
				const outputPath = `${this.renderPath}/${filename}`;
				fs.writeFileSync(outputPath, JSON.stringify(files[filename], null, 4));
				console.log('  ' + outputPath);
			}
		} catch (e) {
			throw new Error(`Failed to write to renderPath. ${e}`);
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
			console.log(`[+] Authenticated as ${caller.Arn ?? caller.arn}`);
			return caller;
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
		throw new Error(`AWS Profile [${profile}] isn't set.`);
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
				throw new Error("AWS profile credential verification error");
			}

			console.log(`[+] Authenticated as ${valid.Arn ?? valid.arn}`);

			if (fs.existsSync(cacheFile)) {
				fs.unlinkSync(cacheFile);
			}

			return valid;

		} catch (e) {
			throw new Error(`Long term credentials for profile [${profile}] are invalid: ${e}`);
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
					throw new Error("AWS credential cache verification error");
				}

				process.env.AWS_PROFILE = '';
				process.env.AWS_ACCESS_KEY_ID = aws.config.credentials.accessKeyId;
				process.env.AWS_SECRET_ACCESS_KEY = aws.config.credentials.secretAccessKey;
				process.env.AWS_SESSION_TOKEN = aws.config.credentials.sessionToken ?? '';

				console.log(`[+] Successfully resumed session as ${cache.profile}; Valid for ${((cache.expireTime - Date.now()) / 60000).toFixed(0)} minutes.`);

				return valid;
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
				throw new Error("AWS assumerole credential verification error");
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

			process.env.AWS_PROFILE = '';
			process.env.AWS_ACCESS_KEY_ID = aws.config.credentials.accessKeyId;
			process.env.AWS_SECRET_ACCESS_KEY = aws.config.credentials.secretAccessKey;
			process.env.AWS_SESSION_TOKEN = aws.config.credentials.sessionToken ?? '';

			return valid;

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

			console.log("");

			if (!token) {
				return getMFAToken(mfaSerial);
			}

			return success(token);
		});

		rl._writeToOutput = function(char) {
			if (char.charCodeAt(0) != 13) {
				rl.output.write('*');
			}
		}
	});
}