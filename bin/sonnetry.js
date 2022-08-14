#! /usr/bin/env node

const fs = require('fs');
const yargs = require('yargs')
const { Sonnet } = require('../src/index.js');

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
			}).option('auto-approve', {
				alias: 'y',
				type: 'boolean',
				description: 'Skip the apply confirmation. Yolo.'
			}).option('skip-init', {
				alias: 's',
				type: 'boolean',
				description: 'Skip provider initialization.'
			}).option('reconfigure', {
				alias: 'r',
				type: 'boolean',
				description: 'Passes the -reconfigure flag to terraform init'
			});
		}, async (argv) => {

			await renderWrite(sonnetry, argv);

			sonnetry.apply(argv.skipInit, argv.autoApprove, argv.reconfigure);
		})
		.command("destroy <filename>", "Destroys all resources in a given configuration", (yargs) => {
			return yargs.positional('filename', {
				describe: 'Jsonnet configuration file to consume'
			}).option('auto-approve', {
				alias: 'y',
				type: 'boolean',
				description: 'Skip the apply confirmation. Yolo.'
			}).option('skip-init', {
				alias: 's',
				type: 'boolean',
				description: 'Skip provider initialization.'
			});
		}, async (argv) => {

			await renderWrite(sonnetry, argv);

			sonnetry.destroy(argv.skipInit, argv.autoApprove);

		})
		.command("generate <filename>", "Generates files from a configuration", (yargs) => {
			return yargs.positional('filename', {
				describe: 'Jsonnet configuration file to consume'
			})
		}, async (argv) => {

			await renderWrite(sonnetry, argv);

		})
		.showHelpOnFail(false)
		.help("help")
		.argv;
})();

async function renderWrite(sonnetry, argv) {
	console.log(`[*] Evaluating ${argv.filename}`);

	try {
		await sonnetry.render(argv.filename);
	} catch (e) {
		console.trace(e);
		console.log(`\n[!] Unable to render ${argv.filename}. Fix the errors above and try again`);
		process.exit(1);
	}

	sonnetry.renderPath = (!!sonnetry.projectName) ? `./render-${sonnetry.projectName}` : './render';

	console.log(`[*] Writing to ${sonnetry.renderPath}`);

	sonnetry.write();

	return true;
}