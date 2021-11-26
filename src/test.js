#! /usr/bin/env node

const fs = require('fs');
const { Sonnet } = require('./index.js');

const sonnetry = new Sonnet({
	renderPath: './render',
	cleanBeforeRender: true
});

(async () => {

	testBootstrap = sonnetry.render(`local sonnetry = import 'sonnetry'; { test: sonnetry.boostrap('test') }`);
	console.log(testBootstrap);

})();