#! /usr/bin/env node

const fs = require('fs');
const yargs = require('yargs')
const terraform = require('@jahed/terraform');
const { Sonnet } = require('../src/index.js');
const { spawnSync } = require('child_process')

const sonnetry = new Sonnet({
	renderPath: './render',
	cleanBeforeRender: true
});

(async () => {

	await sonnetry.auth();

	yargs
		.usage("Syntax: $0 <command> [options]")
		.command("*", "There's no harmony in that", (yargs) => {
			yargs
		}, (argv) => {
			console.log("[~] There's no harmony in that. (Unrecognized command)");
		})
		.command("apply <filename>", "Generates and applies a configuration", (yargs) => {
			return yargs.positional('filename', {
				describe: 'Jsonnet configuration file to consume'
			}).option('auto-apply', {
				alias: 'y',
				type: 'boolean',
				description: 'Skip the apply confirmation. Yolo.'
			}).option('skip-init', {
				alias: 's',
				type: 'boolean',
				description: 'Skip provider initialization.'
			});
		}, async (argv) => {

			console.log(`[+] Evaluating ${argv.filename} into ./render/`);

			await sonnetry.render(argv.filename)
			sonnetry.write();

			const terraformModulePath = require.resolve('@jahed/terraform/package.json').split('/node_modules/')[0];
			const terraformExecPath = terraform.path.split('/node_modules/')[1];

			const terraformBinPath = `${terraformModulePath}/node_modules/${terraformExecPath}`;

			const args = [];

			if (argv.autoApply) {
				args.push('-auto-approve');
			}

			if (!argv.skipInit) {
				const init = spawnSync(terraformBinPath, ['init'], {
					cwd: './render',
					stdio: [process.stdin, process.stdout, process.stderr]
				});

				if (init.status != 0) {
					console.log("[!] Terraform provider initialization failed.");
					process.exit(1);
				}
			}

			const apply = spawnSync(terraformBinPath, ['apply'].concat(args), {
				cwd: './render',
				stdio: [process.stdin, process.stdout, process.stderr]
			});

			if (apply.status != 0) {
				console.log("[!] Terraform apply failed.");
				process.exit(1);
			}

			console.log(`[+] Successfully applied`)
		})
		.command("generate <filename>", "Generates files from a configuration", (yargs) => {
			yargs.positional('filename', {
				describe: 'Jsonnet configuration file to consume'
			})
		}, (argv) => {
			
		})
		.showHelpOnFail(false)
		.help("help")
		.argv;
})();