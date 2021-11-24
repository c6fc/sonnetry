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
const readline = require("readline");
const { spawnSync } = require('child_process');
const { Jsonnet } = require("@hanazuki/node-jsonnet");

aws.config.update({
	region: process.env?.AWS_DEFAULT_REGION ?? "us-east-1"
});

exports.Sonnet = class {
	renderPath; cleanBeforeRender; jsonnet; lastRender; terraformBinPath;
	constructor(options) {
		const self = this;

		options.renderPath ??= "./render";
		options.cleanBeforeRender ??= false;

		try {
			if (!fs.existsSync(options.renderPath)) {
				fs.mkdirSync(options.renderPath);
			}
		} catch (e) {
			throw new Error(`Sonnetry Error: renderPath could not be created. ${e}`);
		}

		const terraformModulePath = require.resolve('@jahed/terraform/package.json').split('/node_modules/')[0];
		const terraformExecPath = terraform.path.split('/node_modules/')[1];

		this.terraformBinPath = `${terraformModulePath}/node_modules/${terraformExecPath}`;

		self.renderPath = options.renderPath;
		self.cleanBeforeRender = options.cleanBeforeRender;

		self.jsonnet = new Jsonnet()
			.addJpath(path.join(__dirname, '../lib'))
			.nativeCallback("aws", (clientObj, method, params) => {
				clientObj = JSON.parse(clientObj);

				const client = new aws[clientObj.service](clientObj.params);

				return client[method](JSON.parse(params)).promise();
			}, "clientObj", "method", "params")
			.nativeCallback("bootstrap", (project) => {
				return self.bootstrap(project);
			}, "project");

		return self;
	}

	apply(skipInit = false, autoApprove = false) {
		
		const args = [];

		if (autoApprove) {
			args.push('-auto-approve');
		}

		if (!skipInit) {
			const init = spawnSync(this.terraformBinPath, ['init'], {
				cwd: './render',
				stdio: [process.stdin, process.stdout, process.stderr]
			});

			if (init.status != 0) {
				console.log(`[!] Terraform provider initialization failed with status code ${init.status}`);
				process.exit(init.status);
			}
		}

		let apply = spawnSync(this.terraformBinPath, ['apply'].concat(args), {
			cwd: './render',
			stdio: [process.stdin, process.stdout, process.stderr]
		});

		if (apply.status != 0) {
			if (skipInit) {
				console.log(`[!] Terraform apply failed with status code ${apply.status}`);
				process.exit(apply.status);
			}

			console.log('[*] Attempting automatic initialization.');

			this.init();

			apply = spawnSync(this.terraformBinPath, ['apply'].concat(args), {
				cwd: './render',
				stdio: [process.stdin, process.stdout, process.stderr]
			});

			if (apply.status != 0) {
				console.log(`[!] Terraform apply failed with status code ${apply.status}`);
				process.exit(apply.status);
			}
		}

		console.log(`[+] Successfully applied`);
	}

	async auth() {
		return await setAwsCredentials();
	}

	async getBootstrapBucket() {
		const rg = new aws.ResourceGroups();

		const resources = await rg.searchResources({
			ResourceQuery: {
				Type: "TAG_FILTERS_1_0",
				Query: JSON.stringify({
					ResourceTypeFilters: ["AWS::S3::Bucket"],
					TagFilters: [{
						Key: "sonnetry-backend",
						Values: ["true"]
					}]
				})
			}
		}).promise();

		if (resources.ResourceIdentifiers.length == 1) {
			return resources.ResourceIdentifiers[0].ResourceArn;
		}

		if (resources.ResourceIdentifiers.length > 1) {
			console.log("[!] More than one bootstrap bucket exists in this account. Fix this before continuing.");
			process.exit(1);
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
			} catch (e) {
				console.log(`Sonnetry error: Unable to create bucket: ${e}`);
				process.exit(1);
			}

			bootstrapBucket = `arn:aws:s3:::${bucketName}`;
		} else {
			bucketName = bootstrapBucket.substr(13);
		}

		const [tagging, versioning, blocking] = await Promise.all([
			s3.getBucketTagging({
				Bucket: bucketName
			}).promise(),
			s3.getBucketVersioning({
				Bucket: bucketName
			}).promise(),
			s3.getPublicAccessBlock({
				Bucket: bucketName
			}).promise(),
		]);

		const isTagged = tagging.TagSet
			.filter(e => e.Key == 'sonnetry-backend' && e.Value == 'true')
			.length == 1;

		const isVersioned = versioning.Status == "Enabled";

		const isBlocked = Object.entries(blocking.PublicAccessBlockConfiguration)
			.filter(e => e.value == false)
			.length == 0;

		if (!isTagged) {
			await s3.putBucketTagging({
				Bucket: bucketName,
				Tagging: {
					TagSet: [{
						Key: "sonnetry-backend",
						Value: "true"
					}]
				}
			}).promise();
		}

		if (!isVersioned) {
			await s3.putBucketVersioning({
				Bucket: bucketName,
				VersioningConfiguration: {
					MFADelete: "Disabled",
					Status: "Enabled"
				}
			}).promise();
		}

		if (!isBlocked) {
			await s3.putPublicAccessBlock({
				Bucket: bucketName,
				PublicAccessBlockConfiguration: {
					BlockPublicAcls: true,
					BlockPublicPolicy: true,
					IgnorePublicAcls: true,
					RestrictPublicBuckets: true
				}
			}).promise();
		}

		let bootstrapLocation = await s3.getBucketLocation({
			Bucket: bucketName
		}).promise();

		bootstrapLocation = (bootstrapLocation.LocationConstraint == '') ? "us-east-1" : bootstrapLocation.LocationConstraint;

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
			cwd: './render',
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
			cwd: './render',
			stdio: [process.stdin, process.stdout, process.stderr]
		});

		if (init.status != 0) {
			console.log(`[!] Terraform init failed with status code ${init.status}`);
			process.exit(init.status);
		}

		console.log(`[+] Successfully initialized`);
	}

	async render(file) {
		if (!fs.existsSync(file)) {
			throw new Error(`Sonnetry Error: ${file} does not exist.`);
		}

		this.renderPath = (this.renderPath.split("").slice(-1)[0] == "/") ?
			this.renderPath.split("").slice(0, -1).join("") :
			this.renderPath;

		this.lastRender = JSON.parse(await this.jsonnet.evaluateFile(file));

		return this.lastRender;
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
				fs.mkdirSync(this.renderPath);
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
				console.log(`[!] Failed to remove *.tf.json files from renderPath. ${e}`);
				process.exit(1);
			}
		}

		try {
			for (const filename in files) {
				const outputPath = `${this.renderPath}/${filename}`;
				fs.writeFileSync(outputPath, JSON.stringify(files[filename], null, 4));
				console.log('  ' + outputPath);
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
			console.log(`[+] Using ${caller.Arn ?? caller.arn}`);
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

				process.env.AWS_PROFILE = '';
				process.env.AWS_ACCESS_KEY_ID = aws.config.credentials.accessKeyId;
				process.env.AWS_SECRET_ACCESS_KEY = aws.config.credentials.secretAccessKey;
				process.env.AWS_SESSION_TOKEN = aws.config.credentials.sessionToken ?? '';

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

			process.env.AWS_PROFILE = '';
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