'use strict';

const fs = require("fs");
const path = require("path");

const Plugin = class {
	#name; #namespace; #verified;

	constructor(name) {
		this.#name = name;

		return this.verifyPlugin();
	}

	verifyPlugin() {
		const plugin = require(this.#name);

		
	}
};