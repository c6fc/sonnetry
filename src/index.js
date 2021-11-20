'use strict';

const fs = require("fs");
const aws = require("aws-sdk");
const terraform = require("@jahed/terraform");
const { Jsonnet } = require("@hanazuki/node-jsonnet");

const jsonnet = new Jsonnet();

// console.log(terraform);

aws.config.update({
	region: "us-east-1"
});

jsonnet
	.nativeCallback("log", (what) => {
		console.log(what);

		return true;
	}, "what")
	.nativeCallback("aws", (clientObj, method, params) => {
		clientObj = JSON.parse(clientObj);

		const client = new aws[clientObj.service](clientObj.params);

		return client[method](JSON.parse(params)).promise();
	}, "clientObj", "method", "params")
	.evaluateFile('awsonnet.jsonnet')
	.then(json => console.log(json));